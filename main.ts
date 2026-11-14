// Entry lifecycle, following the contract env/src/wire.ts fixes: grab an ephemeral
// port, report that port to the env, then keep polling until the env declares the
// trial finished and leave with exit 0. The graded surface is the server built in
// app.ts; this file only drives the harness protocol around it.
//
//   1. MAKEFUN_ENV_URL carries the env's origin (http://store:8080 inside a trial
//      container). With no origin there is nobody to register with, so exit 1 at once.
//   2. Build the server and listen(0) so the kernel assigns a free port. Port 8080
//      belongs to the env and is never bound here.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env stores the caller's
//      address together with N as the base URL it dials from then on. The earliest
//      register wins; a 409 says another entry registered first, and this process
//      simply keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body reads {"done": true}. The env
//      replies immediately ({"done": false} while the suite runs), so this is a
//      poll rather than a held-open request. A failed or slow poll is retried with
//      a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes
//      the export the scorer reads.
//
// main.ts pulls in its own server and nothing else: no package, no Node built-in,
// no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Budget for a single register or done request before it is dropped and retried. */
const REQ_TIMEOUT_MS = 30_000;
/** The first gap between retries, and the ceiling that gap grows to. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Gap to wait once `attempt` requests have failed: doubles from BACKOFF_FIRST_MS, capped. */
function backoffFor(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env takes it. 200 is the normal answer; 409 means an earlier
 * register already won, which is not this process's problem to fix. 400 and 405 are contract
 * errors and end the program; a network error or any other status is retried, since the env
 * may still be starting.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoffFor(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoffFor(attempt));
  }
}

/** Bind the port, announce it, then wait for the env: the whole life of the process. */
async function runLifecycle(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await runLifecycle();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
