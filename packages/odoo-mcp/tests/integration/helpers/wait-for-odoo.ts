/**
 * Integration test helper — poll Odoo until it becomes ready.
 *
 * Uses native fetch (Node 22). No external dependencies.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const PROGRESS_INTERVAL_MS = 15_000;

/**
 * Poll `GET ${baseUrl}/web/database/list` every 3 seconds until HTTP 200 is
 * returned or the timeout elapses.
 *
 * - Swallows network errors (ECONNREFUSED, ENOTFOUND) — they mean Odoo is not
 *   up yet and polling should continue.
 * - Writes a JSON progress line to stderr every 15 seconds.
 * - Resolves as soon as the endpoint returns HTTP 200.
 * - Rejects with an Error if the timeout is exceeded before a 200 is seen.
 */
export async function waitForOdoo(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const url = `${baseUrl}/web/database/list`;
  const startMs = Date.now();
  const deadlineMs = startMs + timeoutMs;
  let lastProgressMs = startMs;

  while (true) {
    const nowMs = Date.now();

    if (nowMs >= deadlineMs) {
      throw new Error(`Odoo did not become ready within ${timeoutMs}ms`);
    }

    // Emit progress to stderr every 15 seconds.
    if (nowMs - lastProgressMs >= PROGRESS_INTERVAL_MS) {
      lastProgressMs = nowMs;
      process.stderr.write(
        `${JSON.stringify({
          event: 'waiting_for_odoo',
          elapsed_ms: nowMs - startMs,
          baseUrl,
        })}\n`,
      );
    }

    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.status === 200) {
        return;
      }
      // Non-200 means Odoo is up but not ready (e.g. 404, 500 during init).
      // Continue polling.
    } catch {
      // Network error (ECONNREFUSED, ENOTFOUND, etc.) — Odoo not up yet.
      // Swallow and continue polling.
    }

    // Wait before the next attempt, but don't wait past the deadline.
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Odoo did not become ready within ${timeoutMs}ms`);
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
