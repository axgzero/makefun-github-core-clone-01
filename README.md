# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/axgzero/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/axgzero/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, stdlib only: git smart HTTP (upload-pack v2, receive-pack v0) for clone/fetch/push, REST v3 for repositories, branches, commits, contents, issues, labels and pull requests with squash merges, GraphQL v4 for the documents `gh` and `github-mcp-server` send, and an MCP endpoint over streamable HTTP. In-memory store, no git binary, no outside service, no UI.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cefc1nk2&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it implements

- **Git smart HTTP** at `/<owner>/<repo>.git`: `info/refs` (v2 advertisement when `Git-Protocol: version=2` is sent, v0 otherwise), `git-upload-pack` with v2 `ls-refs` and `fetch` (including shallow clones, deepen, and v0 fallback) and `git-receive-pack` v0 with report-status. Packfiles are written undeltified and read back with OFS/REF delta support; pushes enforce fast-forward rules per ref with `non-fast-forward` refusals.
- **REST v3** under `/api/v3`: repositories (create/read/patch/delete, paginated `GET /user/repos` with `Link` headers), branches, commits, the Git Data ref API, contents (create/update/delete with stale-sha `409`s), labels, issues with comments, and pull requests with file diffs and three-way squash merges (conflicted merges answer `405`).
- **GraphQL v4** at `/api/graphql`: a small executor for the fixed documents `gh` uses — viewer/repository reads, `__type` introspection, issue and pull-request lists with cursor pagination, `node(id:)` Relay round-trips, and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations — plus operation batching.
- **MCP** at `/mcp`: JSON-RPC 2.0 streamable HTTP with `server/discover` (revision `2026-07-28`), the legacy `initialize` handshake, and seven tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`, `get_issue`) acting on the same store as REST.

## Notes

- The program is `main.ts` (the harness lifecycle, unchanged from the starter) plus `app.ts` (the whole forge). Nothing to install: Node 22 stdlib only.
- The server binds an ephemeral port and registers it with `$MAKEFUN_ENV_URL` within the boot budget; it reads the shop token from `MAKEFUN_SHOP_TOKEN` and the trial's fixed now from `MAKEFUN_TRIAL_NOW`, so a trial replays deterministically.
- Local grading with the kit's own suite: `node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:<port> --token <token> --perf`.
