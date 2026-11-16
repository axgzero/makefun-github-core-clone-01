// Entry point: the trial lifecycle for the forge.
//
// The harness (the env at MAKEFUN_ENV_URL) drives the whole trial. This
// process only has three jobs: pick a port of its own, tell the env which
// port that is, and stay alive serving the forge until the env says the
// trial is over. Nothing here touches the forge's data — that all lives
// in app.ts. This file is just the handshake and the wait.
//
// Order of operations:
//   1. Read MAKEFUN_ENV_URL. With no env to talk to there is no trial,
//      so fail fast instead of hanging.
//   2. Build the server and listen on port 0. The kernel hands back a
//      free port; we never ask for 8080, which belongs to the env.
//   3. POST {"port": <ours>} to <env>/register. First registration wins.
//   4. GET <env>/done in a loop until it answers {"done": true}.
//   5. Shut the server down and leave with code 0.

import { createApp } from './app.ts';

// How long a single register/done request gets before we give up on it.
const CALL_BUDGET_MS = 30_000;
// Backoff ladder for retries: start here, double, never pass the cap.
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const trimmed = raw.trim();
  // Drop trailing slashes so `${origin}/register` is always well formed.
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '/') end -= 1;
  return trimmed.slice(0, end);
}

const ORIGIN = envOrigin();
if (ORIGIN === '') {
  process.stderr.write('[boot] MAKEFUN_ENV_URL is empty: no env to register with\n');
  process.exit(1);
}

const pause = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

function backoffMs(failures: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(failures, 8);
  return doubled < BACKOFF_CAP_MS ? doubled : BACKOFF_CAP_MS;
}

/**
 * Tell the env the port we bound. Keep trying until it sticks: a 200
 * means we registered, a 409 means somebody registered first and there
 * is nothing for us to do about it, so both count as done. 400/405 mean
 * we spoke the contract wrong — that will not fix itself, so it is fatal.
 * Anything else (env still booting, a dropped connection, a slow reply)
 * is worth another attempt after a short wait.
 */
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
    } catch {
      reply = null; // network hiccup: fall through to the retry below
    }
    if (reply !== null) {
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        const detail = await reply.text().catch(() => '');
        throw new Error(`register refused with HTTP ${reply.status}${detail ? `: ${detail}` : ''}`);
      }
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/**
 * Ask the env, over and over, whether the trial is finished. The env
 * answers immediately every time ({"done": false} while the suite is
 * still running), so this is a poll loop, not a held-open request. A
 * failed poll is just a "not done yet" — wait a little and ask again.
 * This function only returns once the env says the trial is over.
 */
async function awaitFinish(): Promise<void> {
  let failures = 0;
  for (;;) {
    let finished = false;
    try {
      const reply = await fetch(`${ORIGIN}/done`, {
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        finished = payload.done === true;
      }
    } catch {
      finished = false; // env unreachable for now: keep polling
    }
    if (finished) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Bind the forge, announce the port, then wait for the env to finish us. */
async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server bound no TCP port');
  }
  const port = bound.port;
  if (port === 8080) {
    // Port 0 should never hand us 8080, but the env owns that port and
    // the suite listens there — refusing to run on it is cheap insurance.
    throw new Error('refusing to serve on port 8080, which belongs to the env');
  }
  process.stdout.write(`[boot] forge listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('[boot] port registered; waiting for the trial to finish\n');

  await awaitFinish();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write('[boot] trial finished; shutting down\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[boot] ${message}\n`);
  process.exit(1);
}
