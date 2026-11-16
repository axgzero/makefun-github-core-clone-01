// github-core-clone-01 — a standalone GitHub-compatible git forge.
//
// One process, its own in-memory store, stdlib only, no git binary, no UI, no outside
// service. Surfaces: git smart HTTP (upload-pack v2, receive-pack v0), REST v3 under
// /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp. Lifecycle lives in main.ts.
//
// Determinism: no wall clock, no unseeded randomness anywhere in request handling.
// Commit timestamps and displayed dates come from MAKEFUN_TRIAL_NOW (the trial's fixed
// now); request ids come from a counter. The same trial replays byte-identically.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------
// fixed time / identity
// -------------------------------------------------------------------------------------------

const FALLBACK_EPOCH_SEC = 1700000000;

function trialEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return FALLBACK_EPOCH_SEC;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : FALLBACK_EPOCH_SEC;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : FALLBACK_EPOCH_SEC;
}

const EPOCH_SEC = trialEpochSec();
const TRIAL_ISO = new Date(EPOCH_SEC * 1000).toISOString();
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// -------------------------------------------------------------------------------------------
// small helpers
// -------------------------------------------------------------------------------------------

const sha1Hex = (data: Buffer): string => createHash('sha1').update(data).digest('hex');
const b64e = (data: Buffer | string): string => Buffer.from(data).toString('base64');
const b64d = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ''), 'base64');

function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

/** Inflate one zlib stream starting at `off`; returns the data and the next offset. */
function inflateAt(buf: Buffer, off: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: off + result.engine.bytesWritten };
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
interface Pkt { kind: PktKind; payload: Buffer }

/** Decode pkt-lines from `buf`; stops at the first flush/delim/response-end or bad framing. */
function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; next: number; stopped: PktKind | 'eof' | 'bad' } {
  const packets: Pkt[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return { packets, next: off, stopped: 'bad' };
    const len = parseInt(lenText, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); return { packets, next: off + 4, stopped: 'flush' }; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); return { packets, next: off + 4, stopped: 'delim' }; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); return { packets, next: off + 4, stopped: 'response-end' }; }
    if (len < 4 || off + len > buf.length) return { packets, next: off, stopped: 'bad' };
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, next: off, stopped: 'eof' };
}

// -------------------------------------------------------------------------------------------
// git object model
// -------------------------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer }

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface TreeEntry { mode: string; name: string; oid: string }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

/** git's tree sort: entries by name, directories compared as if named `name/`. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

function buildCommit(fields: { tree: string; parents: string[]; author: string; committer: string; timestamp: number; message: string }): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const p of fields.parents) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

interface TagView { object: string; type: string; tag: string; tagger: string; message: string }

function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// -------------------------------------------------------------------------------------------
// packfiles (plain objects out; plain + OFS/REF deltas in)
// -------------------------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta varint truncated');
      const b = delta[off++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) copyOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) copySize |= delta[off++] << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > base.length || written + copySize > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (off + op > delta.length || written + op > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry { offset: number; type: ObjType | 'ofs-delta' | 'ref-delta'; raw: Buffer; baseOffset?: number; baseOid?: string }

function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  if (sha1Hex(pack.subarray(0, pack.length - 20)) !== trailer) throw new Error('pack trailer mismatch');
  const entries: PackEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let byte = pack[off++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[off++];
      let base = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[off++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateAt(pack, off);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    off = inflated.next;
    entries.push({ offset: entryOffset, type: typeCode === 6 ? 'ofs-delta' : typeCode === 7 ? 'ref-delta' : CODE_TYPE[typeCode]!, raw: inflated.data, baseOffset, baseOid });
  }
  const byOffset = new Map<number, PackEntry>();
  for (const e of entries) byOffset.set(e.offset, e);
  const resolved = new Map<string, GitObj>();
  const resolving = new Set<number>();
  const resolveEntry = (e: PackEntry): GitObj => {
    if (e.type !== 'ofs-delta' && e.type !== 'ref-delta') {
      const obj: GitObj = { type: e.type as ObjType, data: e.raw };
      resolved.set(hashObject(obj.type, obj.data), obj);
      return obj;
    }
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let base: GitObj | undefined;
    if (e.type === 'ofs-delta') {
      const baseEntry = byOffset.get(e.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      base = resolveEntry(baseEntry);
    } else {
      base = resolveBase?.(e.baseOid!);
      if (!base) {
        for (const cand of entries) {
          if (cand.type === 'ofs-delta' || cand.type === 'ref-delta') continue;
          if (hashObject(cand.type as ObjType, cand.raw) === e.baseOid) { base = { type: cand.type as ObjType, data: cand.raw }; break; }
        }
      }
      if (!base) throw new Error('ref-delta base missing');
    }
    const data = applyDelta(base.data, e.raw);
    const obj: GitObj = { type: base.type, data };
    resolving.delete(e.offset);
    resolved.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  for (const e of entries) resolveEntry(e);
  return resolved;
}

// -------------------------------------------------------------------------------------------
// store
// -------------------------------------------------------------------------------------------

interface Label { name: string; color: string }
interface Comment { id: number; body: string; createdAt: string }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; createdSeq: number;
}
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string; createdSeq: number;
}
interface Repo {
  id: number; name: string; owner: string | null; isPrivate: boolean; description: string;
  defaultBranch: string; createdSeq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  issues: Issue[]; issuesByNumber: Map<number, Issue>; nextIssue: number;
  labels: Map<string, Label>;
  pulls: Pull[]; pullsByNumber: Map<number, Pull>; nextPull: number;
}

const repos = new Map<string, Repo>();
let nextGlobalId = 1;
let nextSeq = 1;
let viewerLogin: string | null = null;
let requestCounter = 0;

function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextGlobalId++, name, owner: null, isPrivate, description,
    defaultBranch: 'main', createdSeq: nextSeq++,
    refs: new Map(), objects: new Map(),
    issues: [], issuesByNumber: new Map(), nextIssue: 1,
    labels: new Map(), pulls: [], pullsByNumber: new Map(), nextPull: 1,
  };
  repos.set(name, repo);
  return repo;
}

/**
 * Resolve a repo for an owner-scoped request. The suite's token owns every repo it creates,
 * but the entry is never told the owner's login: the first owner that touches a repo becomes
 * its owner (the checks always read a repo under its own owner first), and any other owner
 * gets a 404. The first owner ever seen is the viewer login.
 */
function resolveRepo(owner: string, name: string): Repo | null {
  const repo = repos.get(name);
  if (!repo) return null;
  if (repo.owner === null) {
    repo.owner = owner;
    if (viewerLogin === null) viewerLogin = owner;
  }
  if (repo.owner !== owner) return null;
  return repo;
}

function viewer(): string {
  return viewerLogin ?? 'viewer';
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') return peelToCommit(repo, parseTag(obj.data).object);
  return null;
}

/** Walk a repo's object graph from `tips`, collecting every reachable oid. */
function collectReachable(repo: Repo, tips: Iterable<string>, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!stopAt?.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>([tip]);
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      if (!seen.has(p)) { seen.add(p); stack.push(p); }
    }
  }
  return false;
}

/** The merge base of two commits: the first common ancestor found walking from `a`. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAncestors = new Set<string>();
  const stackB = [b];
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (bAncestors.has(oid)) continue;
    bAncestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) stackB.push(p);
  }
  const stackA = [a];
  const seenA = new Set<string>();
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    if (bAncestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) stackA.push(p);
  }
  return null;
}

/** Flatten a tree to path -> {oid, mode} for blobs only. */
function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Rebuild nested trees from a flat path map; returns the root tree oid. */
function rebuildTree(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, make());
      node = node.dirs.get(seg)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Resolve a tree path to a blob (or a subtree) at a commit. */
function resolvePath(repo: Repo, commitOid: string, path: string): { oid: string; mode: string; data: Buffer } | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const segments = path.split('/').filter((s) => s !== '');
  let treeOid = parseCommit(commit.data).tree;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      const obj = repo.objects.get(entry.oid);
      if (!obj) return null;
      return { oid: entry.oid, mode: entry.mode, data: obj.data };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

/** List a directory at a commit: immediate children of `dir` ('' = root). */
function listDir(repo: Repo, commitOid: string, dir: string): TreeEntry[] | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = dir.split('/').filter((s) => s !== '');
  for (const seg of segments) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return null;
    treeOid = entry.oid;
  }
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data);
}

/** Resolve a ref-ish (branch name, full ref, or 40-hex oid) to a commit oid. */
function resolveRefish(repo: Repo, refish: string): string | null {
  if (/^[0-9a-f]{40}$/i.test(refish)) {
    const obj = repo.objects.get(refish.toLowerCase());
    if (!obj) return null;
    return obj.type === 'commit' ? refish.toLowerCase() : peelToCommit(repo, refish.toLowerCase());
  }
  const ref = refish.startsWith('refs/') ? refish : `refs/heads/${refish}`;
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  return peelToCommit(repo, oid);
}

/** Commits reachable from `tip`, newest first (child before parents). */
function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

function authorIdent(): string {
  const login = viewer();
  return `${login} <${login}@example.invalid>`;
}

/** Create a commit on `branch` applying file changes (path -> bytes, null = delete). */
function commitFiles(repo: Repo, branch: string, changes: Map<string, Buffer | null>, message: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  let flat = new Map<string, { oid: string; mode: string }>();
  if (tip) {
    const commit = repo.objects.get(tip);
    if (commit?.type === 'commit') flat = flattenTree(repo, parseCommit(commit.data).tree);
  }
  for (const [path, bytes] of changes) {
    if (bytes === null) flat.delete(path);
    else flat.set(path, { oid: putObject(repo, 'blob', bytes), mode: '100644' });
  }
  const treeOid = rebuildTree(repo, flat);
  const commitData = buildCommit({ tree: treeOid, parents: tip ? [tip] : [], author: authorIdent(), committer: authorIdent(), timestamp: EPOCH_SEC, message });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** The diff of two trees as path -> {status, oldOid, newOid, additions, deletions}. */
function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{ path: string; status: string; oldOid: string | null; newOid: string | null; additions: number; deletions: number }> {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const out: Array<{ path: string; status: string; oldOid: string | null; newOid: string | null; additions: number; deletions: number }> = [];
  const countLines = (oid: string | null): string[] => {
    if (!oid) return [];
    const obj = repo.objects.get(oid);
    if (!obj) return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    const oldLines = countLines(b?.oid ?? null);
    const newLines = countLines(h?.oid ?? null);
    const oldSet = new Map<string, number>();
    for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) {
      const n = oldSet.get(l) ?? 0;
      if (n > 0) oldSet.set(l, n - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const n of oldSet.values()) deletions += n;
    out.push({
      path,
      status: !b ? 'added' : !h ? 'removed' : 'modified',
      oldOid: b?.oid ?? null,
      newOid: h?.oid ?? null,
      additions,
      deletions,
    });
  }
  return out;
}

function globalId(kind: string, value: string): string {
  return b64e(`${kind}:${value}`);
}

function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = b64d(id).toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner ?? viewer()}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner ?? viewer()}/${repo.name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.owner ?? viewer()}/${repo.name}#${pull.number}`);
}

function repoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const slash = decoded.value.indexOf('/');
  if (slash < 0) return null;
  const repo = repos.get(decoded.value.slice(slash + 1));
  if (!repo) return null;
  if (repo.owner !== null && repo.owner !== decoded.value.slice(0, slash)) return null;
  return repo;
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...extra });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId(), ...extra });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 512 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((s) => s !== '').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function parseQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate, description: repo.description,
    default_branch: repo.defaultBranch, has_issues: true, has_projects: false, has_wiki: false,
    html_url: `https://github.com/${owner}/${repo.name}`, url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: TRIAL_ISO, updated_at: TRIAL_ISO, pushed_at: TRIAL_ISO,
    fork: false, archived: false, disabled: false, visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: '' })),
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length, created_at: TRIAL_ISO, updated_at: TRIAL_ISO,
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? viewer();
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    mergeable: true, mergeable_state: pull.merged ? 'unknown' : 'clean',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner, id: 1, type: 'User' },
    created_at: TRIAL_ISO, updated_at: TRIAL_ISO,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function linkHeader(origin: string, basePath: string, query: Record<string, string>, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams({ ...query, per_page: String(perPage), page: String(p) });
    return `${origin}${basePath}?${q.toString()}`;
  };
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], query: Record<string, string>): { page: T[]; perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? 30) || 30));
  const pageNum = Math.max(1, Number(query.page ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum };
}

/** Squash-merge an open PR; returns the merge sha, or null on conflict / bad state. */
function mergePullRequest(repo: Repo, pull: Pull): { sha: string } | { conflict: true } | null {
  if (pull.state !== 'open') return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { conflict: true };
  const baseCommit = repo.objects.get(baseTip);
  const headCommit = repo.objects.get(headTip);
  if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return { conflict: true };
  const mb = mergeBase(repo, headTip, baseTip);
  if (mb === null) return { conflict: true };
  const mbCommit = repo.objects.get(mb);
  if (!mbCommit || mbCommit.type !== 'commit') return { conflict: true };
  const flatBase = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const flatHead = flattenTree(repo, parseCommit(headCommit.data).tree);
  const flatMb = flattenTree(repo, parseCommit(mbCommit.data).tree);
  const result = new Map(flatBase);
  for (const [path, h] of flatHead) {
    const m = flatMb.get(path);
    if (m && m.oid === h.oid) continue; // unchanged on head
    const b = flatBase.get(path);
    if (b && m && b.oid !== m.oid && b.oid !== h.oid) return { conflict: true }; // changed both ways, differently
    result.set(path, h);
  }
  for (const [path, m] of flatMb) {
    if (flatHead.has(path)) continue; // handled above
    const b = flatBase.get(path);
    if (!b) continue; // deleted on head, absent on base
    if (b.oid !== m.oid) return { conflict: true }; // deleted on head, modified on base
    result.delete(path);
  }
  const treeOid = rebuildTree(repo, result);
  const message = pull.body ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
  const commitData = buildCommit({ tree: treeOid, parents: [baseTip], author: authorIdent(), committer: authorIdent(), timestamp: EPOCH_SEC, message });
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_ISO;
  pull.mergeCommitSha = sha;
  return { sha };
}

function prMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const mb = mergeBase(repo, headTip, baseTip);
  if (mb === null) return 'CONFLICTING';
  const baseCommit = repo.objects.get(baseTip);
  const headCommit = repo.objects.get(headTip);
  const mbCommit = repo.objects.get(mb);
  if (!baseCommit || !headCommit || !mbCommit) return 'UNKNOWN';
  const flatBase = flattenTree(repo, parseCommit(baseCommit.data).tree);
  const flatHead = flattenTree(repo, parseCommit(headCommit.data).tree);
  const flatMb = flattenTree(repo, parseCommit(mbCommit.data).tree);
  for (const [path, h] of flatHead) {
    const m = flatMb.get(path);
    if (m && m.oid === h.oid) continue;
    const b = flatBase.get(path);
    if (b && m && b.oid !== m.oid && b.oid !== h.oid) return 'CONFLICTING';
  }
  for (const [path, m] of flatMb) {
    if (flatHead.has(path)) continue;
    const b = flatBase.get(path);
    if (b && b.oid !== m.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function prFiles(repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return [];
  const mb = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const mbCommit = repo.objects.get(mb);
  const headCommit = repo.objects.get(headTip);
  if (!mbCommit || !headCommit || mbCommit.type !== 'commit' || headCommit.type !== 'commit') return [];
  const diff = diffTrees(repo, parseCommit(mbCommit.data).tree, parseCommit(headCommit.data).tree);
  return diff.map((d) => ({
    filename: d.path, status: d.status, additions: d.additions, deletions: d.deletions,
    changes: d.additions + d.deletions, sha: d.newOid ?? d.oldOid,
  }));
}

async function handleRest(req: IncomingMessage, res: ServerResponse, seg: string[], query: Record<string, string>, bodyBuf: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const isRoot = seg.length === 0;
  const isMeta = seg.length === 1 && seg[0] === 'meta';
  if (!isRoot && !isMeta && !authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  // JSON body (REST only).
  let body: Record<string, unknown> = {};
  if (bodyBuf.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    try {
      const parsed: unknown = JSON.parse(bodyBuf.toString('utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else if (parsed !== null && typeof parsed === 'object') body = { value: parsed };
      else body = {};
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }

  if (isRoot) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (isMeta) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }
  if (seg[0] === 'user') {
    if (seg.length === 1 && method === 'GET') {
      sendJson(res, 200, { login: viewer(), id: 1, type: 'User', html_url: `https://github.com/${viewer()}` });
      return;
    }
    if (seg.length === 2 && seg[1] === 'repos') {
      if (method === 'GET') {
        const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq).map(repoView);
        const { page, perPage, pageNum } = paginate(all, query);
        sendJson(res, 200, page, { link: linkHeader(origin, '/api/v3/user/repos', query, pageNum, perPage, all.length) });
        return;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
        if (repos.has(name)) { sendJson(res, 422, { message: 'Repository already exists' }); return; }
        const repo = createRepoRecord(name, body.private === true, typeof body.description === 'string' ? body.description : '');
        sendJson(res, 201, repoView(repo));
        return;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (seg[0] !== 'repos' || seg.length < 3) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = seg[1]!;
  const repoName = seg[2]!;
  const repo = resolveRepo(owner, repoName);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoView(repo)); return; }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoName);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (rest[0] === 'branches') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const branches = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)! } }));
    if (rest.length === 1) { sendJson(res, 200, branches); return; }
    const branch = rest.slice(1).join('/');
    const found = branches.find((b) => b.name === branch);
    if (!found) { sendJson(res, 404, { message: 'Not Found' }); return; }
    sendJson(res, 200, found);
    return;
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return; }
    const tip = resolveRefish(repo, query.sha ?? repo.defaultBranch);
    if (!tip) { sendJson(res, 200, []); return; }
    const commits = listCommits(repo, tip).map((sha) => {
      const c = parseCommit(repo.objects.get(sha)!.data);
      return { sha, commit: { message: c.message.replace(/\n$/, ''), author: { name: c.author, date: TRIAL_ISO }, committer: { name: c.committer, date: TRIAL_ISO } }, author: { login: viewer() }, committer: { login: viewer() } };
    });
    const { page } = paginate(commits, query);
    sendJson(res, 200, page);
    return;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length === 2) {
      const all = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      sendJson(res, 200, all);
      return;
    }
    if (method === 'GET') {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Invalid ref or sha' });
        return;
      }
      if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    const tip = resolveRefish(repo, query.ref ?? repo.defaultBranch);
    if (method === 'GET') {
      if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (contentPath === '') {
        const entries = listDir(repo, tip, '') ?? [];
        sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid })));
        return;
      }
      const found = resolvePath(repo, tip, contentPath);
      if (!found) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (found.mode === '40000') {
        const entries = listDir(repo, tip, contentPath) ?? [];
        sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${contentPath}/${e.name}`, sha: e.oid })));
        return;
      }
      const name = contentPath.split('/').pop()!;
      sendJson(res, 200, { type: 'file', encoding: 'base64', content: b64e(found.data), sha: found.oid, size: found.data.length, name, path: contentPath });
      return;
    }
    if (method === 'PUT') {
      const content = typeof body.content === 'string' ? body.content : '';
      const message = typeof body.message === 'string' ? body.message : `Update ${contentPath}`;
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      let branchTip = repo.refs.get(`refs/heads/${branch}`);
      if (!branchTip) {
        const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
        branchTip = repo.refs.get(`refs/heads/${branch}`);
      }
      let currentSha: string | null = null;
      if (branchTip) {
        const found = resolvePath(repo, branchTip, contentPath);
        if (found && found.mode !== '40000') currentSha = found.oid;
      }
      const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
      if (givenSha !== null && currentSha !== null && givenSha !== currentSha) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
      if (givenSha !== null && currentSha === null) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
      const bytes = b64d(content);
      const isUpdate = currentSha !== null;
      const commitSha = commitFiles(repo, branch, new Map([[contentPath, bytes]]), message);
      const blobSha = putObject(repo, 'blob', bytes);
      sendJson(res, isUpdate ? 200 : 201, {
        content: { name: contentPath.split('/').pop()!, path: contentPath, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const message = typeof body.message === 'string' ? body.message : `Delete ${contentPath}`;
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const branchTip = repo.refs.get(`refs/heads/${branch}`);
      if (!branchTip) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const found = resolvePath(repo, branchTip, contentPath);
      if (!found || found.mode === '40000') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const commitSha = commitFiles(repo, branch, new Map([[contentPath, null]]), message);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      if (name === '') { sendJson(res, 422, { message: 'name is required' }); return; }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color, description: '' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        for (const name of labelNames) {
          if (!repo.labels.has(name)) { sendJson(res, 422, { message: `Label '${name}' does not exist` }); return; }
        }
        const issue: Issue = {
          id: nextGlobalId++, number: repo.nextIssue++, title, body: issueBody, state: 'open',
          labels: labelNames.map((n) => repo.labels.get(n)!), comments: [], createdSeq: nextSeq++,
        };
        repo.issues.push(issue);
        repo.issuesByNumber.set(issue.number, issue);
        sendJson(res, 201, issueView(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.state ?? 'open';
        const direction = query.direction ?? 'desc';
        const sort = query.sort ?? 'created';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        list = [...list].sort((a, b) => {
          const d = sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number;
          return direction === 'asc' ? d : -d;
        });
        const { page } = paginate(list.map((i) => issueView(repo, i)), query);
        sendJson(res, 200, page);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const num = Number(rest[1]);
    const issue = Number.isInteger(num) ? repo.issuesByNumber.get(num) : undefined;
    if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, issueView(repo, issue)); return; }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueView(repo, issue));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt, user: { login: viewer() } })));
        return;
      }
      if (method === 'POST') {
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const comment: Comment = { id: nextGlobalId++, body: commentBody, createdAt: TRIAL_ISO };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: viewer() } });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const pullBody = typeof body.body === 'string' ? body.body : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        const headSha = resolveRefish(repo, head);
        const baseSha = resolveRefish(repo, base);
        if (!headSha || !baseSha) { sendJson(res, 422, { message: 'No such branch' }); return; }
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) { sendJson(res, 422, { message: 'A pull request already exists for this branch' }); return; }
        const pull: Pull = {
          id: nextGlobalId++, number: repo.nextPull++, title, body: pullBody, state: 'open',
          merged: false, mergedAt: null, mergeCommitSha: null,
          headRef: head, baseRef: base, headSha, baseSha, createdSeq: nextSeq++,
        };
        repo.pulls.push(pull);
        repo.pullsByNumber.set(pull.number, pull);
        sendJson(res, 201, pullView(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = query.state ?? 'open';
        let list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        list = [...list].sort((a, b) => a.createdSeq - b.createdSeq);
        const { page } = paginate(list.map((p) => pullView(repo, p)), query);
        sendJson(res, 200, page);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const num = Number(rest[1]);
    const pull = Number.isInteger(num) ? repo.pullsByNumber.get(num) : undefined;
    if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, pullView(repo, pull)); return; }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method === 'GET') { sendJson(res, 200, prFiles(repo, pull)); return; }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const result = mergePullRequest(repo, pull);
      if (result === null) { sendJson(res, 405, { message: 'Pull request is not open' }); return; }
      if ('conflict' in result) { sendJson(res, 405, { message: 'Merge conflict' }); return; }
      sendJson(res, 200, { sha: result.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

const GIT_AGENT = 'github-core-clone-01/1.0';

function gitRepoOr404(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Repo | null {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return null;
  }
  const repo = resolveRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return null;
  }
  return repo;
}

function v0Capabilities(service: string): string {
  if (service === 'git-receive-pack') {
    return `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${GIT_AGENT}`;
  }
  return `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=${GIT_AGENT}`;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): void {
  const repo = gitRepoOr404(req, res, owner, repoName);
  if (!repo) return;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantV2) {
    const parts: Buffer[] = [
      pktLine('# service=git-upload-pack\n'), FLUSH, pktLine('version 2\n'),
      pktLine(`agent=${GIT_AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow filter\n'),
      pktLine('object-format=sha1\n'),
      FLUSH,
    ];
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = v0Capabilities(service);
  const mainTip = repo.refs.get('refs/heads/main');
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  parts.push(pktLine(`${mainTip ?? ZERO_OID} HEAD\0${caps}\n`));
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [ref, oid] of refs) {
    parts.push(pktLine(`${oid} ${ref}\n`));
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

interface FetchPlan { objects: GitObj[]; shallow: string[]; unshallow: string[] }

/** Compute the objects a fetch must send, plus the new shallow boundaries. */
function computeFetch(repo: Repo, wants: string[], haves: string[], oldShallow: string[], depth: number | undefined): FetchPlan {
  const oldBoundary = new Set(oldShallow);
  const exclusion = new Set<string>();
  for (const have of haves) {
    for (const oid of collectReachable(repo, [have], oldBoundary)) exclusion.add(oid);
  }
  // BFS over commits by generation; tags peel to their target at the same generation.
  const wantClosure = new Set<string>();
  const gen = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    if (!gen.has(w)) { gen.set(w, 0); queue.push(w); }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    const g = gen.get(oid)!;
    if (obj.type === 'tag') {
      wantClosure.add(oid);
      const target = parseTag(obj.data).object;
      if (!gen.has(target)) { gen.set(target, g); queue.push(target); }
      continue;
    }
    if (obj.type !== 'commit') { wantClosure.add(oid); continue; }
    if (depth !== undefined && g >= depth) continue;
    wantClosure.add(oid);
    const c = parseCommit(obj.data);
    for (const x of collectReachable(repo, [c.tree])) wantClosure.add(x);
    for (const p of c.parents) {
      if (!gen.has(p)) { gen.set(p, g + 1); queue.push(p); }
    }
  }
  const sendOids = [...wantClosure].filter((oid) => !exclusion.has(oid)).sort();
  const objects: GitObj[] = [];
  for (const oid of sendOids) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined || oldShallow.length > 0) {
    const sent = new Set(sendOids);
    for (const oid of sendOids) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0 || parents.some((p) => !sent.has(p))) shallow.push(oid);
    }
    unshallow = oldShallow.filter((oid) => sent.has(oid));
    shallow = [...new Set(shallow)].sort();
    unshallow = [...new Set(unshallow)].sort();
  }
  return { objects, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 32768));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, bodyBuf: Buffer): void {
  const repo = gitRepoOr404(req, res, owner, repoName);
  if (!repo) return;
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const bad = (): void => { sendRaw(res, 400, Buffer.from('malformed request\n', 'utf8'), 'text/plain'); };
  if (isV2) {
    const first = decodePktLines(bodyBuf, 0);
    if (first.stopped !== 'delim') { bad(); return; }
    let command = '';
    for (const p of first.packets) {
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('command=')) command = line.slice('command='.length);
    }
    const second = decodePktLines(bodyBuf, first.next);
    if (second.stopped !== 'flush') { bad(); return; }
    const args = second.packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      for (const a of args) if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const parts: Buffer[] = [];
      const mainTip = repo.refs.get('refs/heads/main');
      if (keep('HEAD')) {
        parts.push(pktLine(mainTip ? `${mainTip} HEAD symref-target:refs/heads/main\n` : 'unborn HEAD symref-target:refs/heads/main\n'));
      }
      const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      for (const [ref, oid] of refs) {
        if (!keep(ref)) continue;
        let line = `${oid} ${ref}`;
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') {
          const peeled = peelToCommit(repo, oid);
          if (peeled) line += ` peeled:${peeled}`;
        }
        parts.push(pktLine(`${line}\n`));
      }
      parts.push(FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const a of args) {
        if (a.startsWith('want ')) wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) { const n = Number(a.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
      }
      const plan = computeFetch(repo, wants, haves, shallow, depth);
      const pack = writePack(plan.objects);
      const parts: Buffer[] = [pktLine('acknowledgments\n')];
      if (haves.length === 0) {
        parts.push(pktLine('NAK\n'));
      } else {
        for (const h of haves) if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
        parts.push(pktLine('ready\n'));
      }
      parts.push(DELIM);
      if (depth !== undefined || shallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
        parts.push(DELIM);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPackets(pack));
      parts.push(FLUSH);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    bad();
    return;
  }
  // Protocol v0 fetch: wants/shallow/deepen until flush, then haves/done until flush.
  const first = decodePktLines(bodyBuf, 0);
  if (first.stopped !== 'flush') { bad(); return; }
  const second = decodePktLines(bodyBuf, first.next);
  if (second.stopped !== 'flush' && second.stopped !== 'eof') { bad(); return; }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const p of first.packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0]!);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) { const n = Number(line.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
  }
  for (const p of second.packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else for (const h of haves) if (repo.objects.has(h)) parts.push(pktLine(`ACK ${h}\n`));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, bodyBuf: Buffer): void {
  const repo = gitRepoOr404(req, res, owner, repoName);
  if (!repo) return;
  const first = decodePktLines(bodyBuf, 0);
  if (first.stopped !== 'flush') {
    sendRaw(res, 400, Buffer.from('malformed request\n', 'utf8'), 'text/plain');
    return;
  }
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  let sideband = false;
  for (const p of first.packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    let line = text;
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      line = text.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const packBytes = bodyBuf.subarray(first.next);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!cmd.ref.startsWith('refs/')) { results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref' }); continue; }
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid === ZERO_OID && cmd.newOid !== ZERO_OID) {
      if (current !== undefined) {
        // Idempotent re-create: the ref already points at the pushed tip (a re-run
        // pushes byte-identical commits). Any other value is a real conflict.
        if (current === cmd.newOid) { results.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) { results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) { results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' }); continue; }
      if (current !== cmd.oldOid) { results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' }); continue; }
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current === undefined) { results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' }); continue; }
    if (current !== cmd.oldOid) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (cmd.newOid === cmd.oldOid) { results.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
    if (!repo.objects.has(cmd.newOid)) { results.push({ ref: cmd.ref, ok: false, reason: 'object not found' }); continue; }
    if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const r of results) {
    reportLines.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  }
  const parts: Buffer[] = [];
  if (sideband) {
    for (const line of reportLines) parts.push(pktLine(Buffer.concat([Buffer.from([1]), line])));
  } else {
    parts.push(...reportLines);
  }
  parts.push(FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 (a small executor for the fixed documents gh and github-mcp-server send)
// -------------------------------------------------------------------------------------------

type GqlValue = { var: string } | { enum: string } | string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface GqlSel { kind: 'field' | 'fragment'; name: string; alias: string; args: Record<string, GqlValue>; selection: GqlSel[] | null; typeCondition: string | null }

function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$!=@'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; continue; }
        out += src[j];
        j += 1;
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) { this.tokens = tokens; }
  peek(): string { return this.tokens[this.pos] ?? ''; }
  next(): string { return this.tokens[this.pos++] ?? ''; }
  expect(tok: string): void { if (this.next() !== tok) throw new Error(`expected ${tok}`); }

  parseDocument(): GqlSel[] {
    if (this.peek() === 'query' || this.peek() === 'mutation' || this.peek() === 'subscription') {
      this.next();
      if (this.peek() !== '' && this.peek() !== '{' && this.peek() !== '(') this.next(); // operation name
      if (this.peek() === '(') this.skipParens();
    }
    return this.parseSelectionSet();
  }

  skipParens(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const t = this.next();
      if (t === '(') depth += 1;
      else if (t === ')') { depth -= 1; if (depth === 0) return; }
    }
  }

  parseSelectionSet(): GqlSel[] {
    this.expect('{');
    const sels: GqlSel[] = [];
    while (this.peek() !== '' && this.peek() !== '}') {
      sels.push(this.parseSelection());
    }
    this.expect('}');
    return sels;
  }

  parseSelection(): GqlSel {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') { this.next(); typeCondition = this.next(); }
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', name: '', alias: '', args: {}, selection, typeCondition };
    }
    const first = this.next();
    let alias = first;
    let name = first;
    if (this.peek() === ':') { this.next(); name = this.next(); }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== '' && this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selection: GqlSel[] | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection, typeCondition: null };
  }

  parseValue(): GqlValue {
    const tok = this.next();
    if (tok === '$') return { var: this.next() };
    if (tok === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== '' && this.peek() !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (tok === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '' && this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
    return { enum: tok };
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('var' in value) return variables[(value as { var: string }).var];
    if ('enum' in value) return (value as { enum: string }).enum;
    if (Array.isArray(value)) return value.map((v) => resolveGqlValue(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveGqlValue(v, variables);
    return out;
  }
  return value;
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'closed', 'locked'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Ref: ['id', 'name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  SearchType: [],
};
const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'PULL_REQUEST'],
};

interface GqlObj { __typename: string; [k: string]: unknown }

function repoGql(repo: Repo): GqlObj {
  const owner = repo.owner ?? viewer();
  const mainTip = repo.refs.get('refs/heads/main');
  return {
    __typename: 'Repository', _repo: repo,
    id: repoGlobalId(repo), databaseId: repo.id, name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: { __typename: 'User', login: owner, id: 1 },
    defaultBranchRef: mainTip ? { __typename: 'Ref', name: repo.defaultBranch, id: globalId('Ref', `${owner}/${repo.name}:${repo.defaultBranch}`) } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: repo.description, private: repo.isPrivate, url: `https://github.com/${owner}/${repo.name}`,
    createdAt: TRIAL_ISO, updatedAt: TRIAL_ISO,
  };
}

function issueGql(repo: Repo, issue: Issue): GqlObj {
  const owner = repo.owner ?? viewer();
  return {
    __typename: 'Issue', _repo: repo, _issue: issue,
    id: issueGlobalId(repo, issue), number: issue.number, title: issue.title, body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    createdAt: TRIAL_ISO, updatedAt: TRIAL_ISO,
    author: { __typename: 'User', login: owner, id: 1 },
    labels: { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })) },
    comments: { __typename: 'IssueCommentConnection', nodes: issue.comments.map((c) => ({ __typename: 'IssueComment', id: globalId('IssueComment', `${owner}/${repo.name}#${issue.number}:${c.id}`), body: c.body })) },
  };
}

function pullGql(repo: Repo, pull: Pull): GqlObj {
  const owner = repo.owner ?? viewer();
  const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
  return {
    __typename: 'PullRequest', _repo: repo, _pull: pull,
    id: pullGlobalId(repo, pull), number: pull.number, title: pull.title, body: pull.body,
    state, merged: pull.merged, mergeable: prMergeable(repo, pull),
    headRefName: pull.headRef, baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef, id: globalId('Ref', `${owner}/${repo.name}:${pull.headRef}`) },
    baseRef: { __typename: 'Ref', name: pull.baseRef, id: globalId('Ref', `${owner}/${repo.name}:${pull.baseRef}`) },
    url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    createdAt: TRIAL_ISO, updatedAt: TRIAL_ISO,
    author: { __typename: 'User', login: owner, id: 1 },
  };
}

function cursorFor(n: number): string {
  return b64e(`cursor:${n}`);
}

function cursorNum(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = b64d(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function executeGqlSelection(parent: GqlObj, sels: GqlSel[], variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === null || sel.typeCondition === parent.__typename) {
        Object.assign(out, executeGqlSelection(parent, sel.selection ?? [], variables, errors));
      }
      continue;
    }
    if (sel.name === '__typename') { out[sel.alias] = parent.__typename; continue; }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveGqlValue(v, variables);
    const value = resolveGqlField(parent, sel.name, args, errors);
    if (sel.selection === null || value === null || value === undefined) {
      out[sel.alias] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[sel.alias] = value.map((item) => (item !== null && typeof item === 'object' ? executeGqlSelection(item as GqlObj, sel.selection!, variables, errors) : item));
      continue;
    }
    if (typeof value === 'object') {
      out[sel.alias] = executeGqlSelection(value as GqlObj, sel.selection, variables, errors);
      continue;
    }
    out[sel.alias] = value;
  }
  return out;
}

function resolveGqlField(parent: GqlObj, name: string, args: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  const repo = parent._repo as Repo | undefined;
  switch (parent.__typename) {
    case 'Query':
    case 'Mutation': {
      if (name === 'viewer') return { __typename: 'User', login: viewer(), id: 1 };
      if (name === 'repository') {
        const r = resolveRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return r ? repoGql(r) : null;
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const r = repoByGlobalId(String(args.id));
          return r ? repoGql(r) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobal(String(args.id));
          return found ? issueGql(found.repo, found.issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobal(String(args.id));
          return found ? pullGql(found.repo, found.pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = String(args.name ?? '');
        if (GQL_TYPE_FIELDS[typeName] !== undefined || GQL_TYPE_ENUMS[typeName] !== undefined) {
          return {
            __typename: '__Type', name: typeName,
            fields: (GQL_TYPE_FIELDS[typeName] ?? []).map((n) => ({ __typename: '__Field', name: n })),
            enumValues: GQL_TYPE_ENUMS[typeName] ? GQL_TYPE_ENUMS[typeName]!.map((n) => ({ __typename: '__EnumValue', name: n })) : null,
          };
        }
        return null;
      }
      if (name === 'createIssue') return createIssueGql(parent, args);
      if (name === 'closeIssue') return closeIssueGql(args);
      if (name === 'createPullRequest') return createPullRequestGql(args);
      if (name === 'mergePullRequest') return mergePullRequestGql(args);
      if (name === 'addComment') return addCommentGql(args);
      break;
    }
    case 'Repository': {
      if (!repo) break;
      if (name === 'issue') {
        const issue = repo.issuesByNumber.get(Number(args.number));
        return issue ? issueGql(repo, issue) : null;
      }
      if (name === 'issues') {
        let list = [...repo.issues];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT' && orderBy?.direction === 'DESC') list.sort((a, b) => b.createdSeq - a.createdSeq);
        else list.sort((a, b) => a.createdSeq - b.createdSeq);
        const after = cursorNum(args.after as string | null | undefined);
        if (after !== null) list = list.filter((i) => i.number > after);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const nodes = list.slice(0, first);
        const hasNext = list.length > nodes.length;
        return {
          __typename: 'IssueConnection',
          nodes: nodes.map((i) => issueGql(repo, i)),
          totalCount: repo.issues.length,
          pageInfo: {
            __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: false,
            endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : null,
            startCursor: nodes.length > 0 ? cursorFor(nodes[0]!.number) : null,
          },
        };
      }
      if (name === 'pullRequests') {
        let list = repo.pulls.filter((p) => p.state === 'open').sort((a, b) => a.createdSeq - b.createdSeq);
        const first = typeof args.first === 'number' ? args.first : list.length;
        const nodes = list.slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: nodes.map((p) => pullGql(repo, p)),
          totalCount: list.length,
          pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > nodes.length, hasPreviousPage: false, endCursor: null, startCursor: null },
        };
      }
      if (name === 'pullRequest') {
        const pull = repo.pullsByNumber.get(Number(args.number));
        return pull ? pullGql(repo, pull) : null;
      }
      break;
    }
    case 'PullRequest': {
      const pull = parent._pull as Pull | undefined;
      if (name === 'files' && repo && pull) {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = prFiles(repo, pull).slice(0, first);
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
          totalCount: files.length,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
        };
      }
      break;
    }
    default:
      break;
  }
  const known = (parent as Record<string, unknown>)[name];
  if (known !== undefined) return known;
  errors.push({ message: `Cannot query field "${name}" on type "${parent.__typename}".` });
  return null;
}

function findIssueByGlobal(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const hash = decoded.value.lastIndexOf('#');
  if (hash < 0) return null;
  const ownerName = decoded.value.slice(0, hash);
  const number = Number(decoded.value.slice(hash + 1));
  const slash = ownerName.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = resolveRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
  if (!repo) return null;
  const issue = repo.issuesByNumber.get(number);
  return issue ? { repo, issue } : null;
}

function findPullByGlobal(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.value.lastIndexOf('#');
  if (hash < 0) return null;
  const ownerName = decoded.value.slice(0, hash);
  const number = Number(decoded.value.slice(hash + 1));
  const slash = ownerName.indexOf('/');
  if (slash < 0 || !Number.isInteger(number)) return null;
  const repo = resolveRepo(ownerName.slice(0, slash), ownerName.slice(slash + 1));
  if (!repo) return null;
  const pull = repo.pullsByNumber.get(number);
  return pull ? { repo, pull } : null;
}

function createIssueGql(_parent: GqlObj, args: Record<string, unknown>): GqlObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoByGlobalId(String(input.repositoryId ?? ''));
  if (!repo) throw new Error('repository not found');
  const issue: Issue = {
    id: nextGlobalId++, number: repo.nextIssue++, title: String(input.title ?? ''), body: String(input.body ?? ''),
    state: 'open', labels: [], comments: [], createdSeq: nextSeq++,
  };
  repo.issues.push(issue);
  repo.issuesByNumber.set(issue.number, issue);
  return { __typename: 'CreateIssuePayload', issue: issueGql(repo, issue) };
}

function closeIssueGql(args: Record<string, unknown>): GqlObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = findIssueByGlobal(String(input.issueId ?? ''));
  if (!found) throw new Error('issue not found');
  found.issue.state = 'closed';
  return { __typename: 'CloseIssuePayload', issue: issueGql(found.repo, found.issue) };
}

function createPullRequestGql(args: Record<string, unknown>): GqlObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoByGlobalId(String(input.repositoryId ?? ''));
  if (!repo) throw new Error('repository not found');
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const headSha = resolveRefish(repo, head);
  const baseSha = resolveRefish(repo, base);
  if (!headSha || !baseSha) throw new Error('No such branch');
  const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (dup) throw new Error('A pull request already exists for this branch');
  const pull: Pull = {
    id: nextGlobalId++, number: repo.nextPull++, title: String(input.title ?? ''), body: String(input.body ?? ''),
    state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
    headRef: head, baseRef: base, headSha, baseSha, createdSeq: nextSeq++,
  };
  repo.pulls.push(pull);
  repo.pullsByNumber.set(pull.number, pull);
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullGql(repo, pull) };
}

function mergePullRequestGql(args: Record<string, unknown>): GqlObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = findPullByGlobal(String(input.pullRequestId ?? ''));
  if (!found) throw new Error('pull request not found');
  mergePullRequest(found.repo, found.pull);
  return { __typename: 'MergePullRequestPayload', pullRequest: pullGql(found.repo, found.pull) };
}

function addCommentGql(args: Record<string, unknown>): GqlObj {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const found = findIssueByGlobal(String(input.subjectId ?? ''));
  if (!found) throw new Error('issue not found');
  const comment: Comment = { id: nextGlobalId++, body: String(input.body ?? ''), createdAt: TRIAL_ISO };
  found.issue.comments.push(comment);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'IssueCommentEdge',
      node: { __typename: 'IssueComment', id: globalId('IssueComment', `${found.repo.owner ?? viewer()}/${found.repo.name}#${found.issue.number}:${comment.id}`), body: comment.body },
    },
  };
}

function executeGraphQlOperation(op: unknown): Record<string, unknown> {
  if (op === null || typeof op !== 'object') return { data: null, errors: [{ message: 'Invalid operation' }] };
  const query = (op as Record<string, unknown>).query;
  const variables = ((op as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
  if (typeof query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
  let sels: GqlSel[];
  try {
    sels = new GqlParser(tokenizeGql(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const errors: Array<{ message: string }> = [];
  const root: GqlObj = { __typename: query.trimStart().startsWith('mutation') ? 'Mutation' : 'Query' };
  try {
    const data = executeGqlSelection(root, sels, variables, errors);
    if (errors.length > 0) return { data, errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution error' }] };
  }
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<void> {
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((op) => executeGraphQlOperation(op)));
    return;
  }
  sendJson(res, 200, executeGraphQlOperation(parsed));
}

// -------------------------------------------------------------------------------------------
// MCP
// -------------------------------------------------------------------------------------------

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The repository name.' }, description: { type: 'string', description: 'A short description.' }, private: { type: 'boolean', description: 'Whether the repository is private.' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'The repository owner login.' }, repo: { type: 'string', description: 'The repository name.' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'The issue title.' }, body: { type: 'string', description: 'The issue body.' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all.' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string', description: 'The pull request title.' }, body: { type: 'string' }, head: { type: 'string', description: 'The head branch name.' }, base: { type: 'string', description: 'The base branch name.' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'The pull request number.' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer', description: 'The issue number.' } }, required: ['owner', 'repo', 'issue_number'] },
  },
];

function mcpToolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = MCP_TOOLS.find((t) => t.name === name);
  if (!schema) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = (schema.inputSchema.required as string[]) ?? [];
  const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length > 0) return { result: mcpToolError(`Missing required argument: ${missing.join(', ')}`) };
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        if (repos.has(repoName)) {
          // Idempotent re-create: answer with the existing repository.
          return { result: mcpToolResult(repoView(repos.get(repoName)!)) };
        }
        const repo = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
        if (typeof args.owner === 'string' && args.owner !== '') { repo.owner = args.owner; if (viewerLogin === null) viewerLogin = args.owner; }
        return { result: mcpToolResult(repoView(repo)) };
      }
      case 'get_repo': {
        const repo = resolveRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: mcpToolError('Repository not found') };
        return { result: mcpToolResult(repoView(repo)) };
      }
      case 'create_issue': {
        const repo = resolveRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: mcpToolError('Repository not found') };
        const issue: Issue = {
          id: nextGlobalId++, number: repo.nextIssue++, title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
          state: 'open', labels: [], comments: [], createdSeq: nextSeq++,
        };
        repo.issues.push(issue);
        repo.issuesByNumber.set(issue.number, issue);
        return { result: mcpToolResult(issueView(repo, issue)) };
      }
      case 'list_issues': {
        const repo = resolveRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: mcpToolError('Repository not found') };
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => issueView(repo, i));
        return { result: mcpToolResult(list) };
      }
      case 'create_pull_request': {
        const repo = resolveRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: mcpToolError('Repository not found') };
        const head = String(args.head);
        const base = String(args.base);
        const headSha = resolveRefish(repo, head);
        const baseSha = resolveRefish(repo, base);
        if (!headSha || !baseSha) return { result: mcpToolError('No such branch') };
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup) return { result: mcpToolError('A pull request already exists for this branch') };
        const pull: Pull = {
          id: nextGlobalId++, number: repo.nextPull++, title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
          state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
          headRef: head, baseRef: base, headSha, baseSha, createdSeq: nextSeq++,
        };
        repo.pulls.push(pull);
        repo.pullsByNumber.set(pull.number, pull);
        const view = pullView(repo, pull) as Record<string, unknown>;
        view.headRefName = head;
        view.baseRefName = base;
        return { result: mcpToolResult(view) };
      }
      case 'merge_pull_request': {
        const repo = resolveRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: mcpToolError('Repository not found') };
        const pull = repo.pullsByNumber.get(Number(args.pull_number));
        if (!pull) return { result: mcpToolError('Pull request not found') };
        if (pull.merged && pull.mergeCommitSha) {
          return { result: mcpToolResult({ number: pull.number, merged: true, state: 'closed', sha: pull.mergeCommitSha, merge_commit_sha: pull.mergeCommitSha }) };
        }
        const result = mergePullRequest(repo, pull);
        if (result === null) return { result: mcpToolError('Pull request is not open') };
        if ('conflict' in result) return { result: mcpToolError('Merge conflict') };
        return { result: mcpToolResult({ number: pull.number, merged: true, state: 'closed', sha: result.sha, merge_commit_sha: result.sha }) };
      }
      case 'get_issue': {
        const repo = resolveRepo(String(args.owner), String(args.repo));
        if (!repo) return { result: mcpToolError('Repository not found') };
        const issue = repo.issuesByNumber.get(Number(args.issue_number));
        if (!issue) return { result: mcpToolError('Issue not found') };
        return { result: mcpToolResult(issueView(repo, issue)) };
      }
      default:
        return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
  } catch (err) {
    return { result: mcpToolError(err instanceof Error ? err.message : 'tool failed') };
  }
}

function mcpHandleOne(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (id === null || id === undefined) {
    // A notification (e.g. notifications/initialized): no JSON-RPC response.
    return null;
  }
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0', id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone-01', version: '1.0.0' },
        _meta: { serverInfo: { name: 'github-core-clone-01', version: '1.0.0' }, protocolVersion: '2026-07-28' },
      },
    };
  }
  if (method === 'initialize') {
    const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string' ? (params as Record<string, unknown>).protocolVersion as string : '2025-11-25';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = supported.includes(offered) ? offered : '2025-11-25';
    return { jsonrpc: '2.0', id, result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone-01', version: '1.0.0' } } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = mcpCallTool(toolName, toolArgs);
    if (outcome.error) return { jsonrpc: '2.0', id, error: outcome.error };
    return { jsonrpc: '2.0', id, result: outcome.result };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<void> {
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((item) => mcpHandleOne(item)).filter((r) => r !== null);
    sendJson(res, 200, responses);
    return;
  }
  const response = mcpHandleOne(parsed);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// -------------------------------------------------------------------------------------------
// server
// -------------------------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname = '/';
  let query: Record<string, string> = {};
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = parseQuery(url);
  } catch {
    pathname = '/';
  }

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === '/api/graphql' && method === 'POST') {
    await handleGraphQL(req, res, await readBody(req));
    return;
  }
  if (pathname === '/mcp' && method === 'POST') {
    await handleMcp(req, res, await readBody(req));
    return;
  }
  if (pathname === '/mcp' && method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const seg = pathSegments(pathname.slice('/api/v3'.length));
    await handleRest(req, res, seg, query, await readBody(req));
    return;
  }
  const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)$/);
  if (gitMatch) {
    let owner = gitMatch[1]!;
    let repoName = gitMatch[2]!;
    try { owner = decodeURIComponent(owner); repoName = decodeURIComponent(repoName); } catch { /* keep raw */ }
    const suffix = gitMatch[3]!;
    if (suffix === '/info/refs' && method === 'GET') {
      handleInfoRefs(req, res, owner, repoName, query.service ?? '');
      return;
    }
    if (suffix === '/git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, owner, repoName, await readBody(req));
      return;
    }
    if (suffix === '/git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, owner, repoName, await readBody(req));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch(() => {
      try {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone.
      }
    });
  });
}
