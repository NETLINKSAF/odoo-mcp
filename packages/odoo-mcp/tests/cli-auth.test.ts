/**
 * Tests for cli-auth.ts (T-14).
 *
 * Covers:
 *  1. Happy path — full DCR → callback → token exchange flow.
 *  2. Timeout — no callback within 120 s.
 *  3. Token exchange error — PKCE failure.
 *  4. State mismatch — possible CSRF.
 *  5. Loopback bind — server.listen called with '127.0.0.1' (US-13 AC-7).
 *  6. Missing serverUrl — exits 1 with error message.
 *  7. buildAuthorizeUrl helper.
 *  8. validateState helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

// ---------------------------------------------------------------------------
// Mock node:child_process so we don't actually open a browser.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, cb?: (err: null, stdout: string, stderr: string) => void) => {
    if (cb) cb(null, '', '');
  }),
}));

// ---------------------------------------------------------------------------
// Fetch mock helpers.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import helpers (pure functions).
// ---------------------------------------------------------------------------
import { buildAuthorizeUrl, validateState } from '../src/cli-auth.js';

// ---------------------------------------------------------------------------
// Helper: make a fake fetch Response.
// ---------------------------------------------------------------------------
function makeFetchResponse(body: unknown, status = 200): Response {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => json,
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Helper: simulate a browser hitting the callback URL on the running server.
// ---------------------------------------------------------------------------
async function hitCallback(
  port: number,
  params: { code: string; state: string },
): Promise<void> {
  const url = `http://127.0.0.1:${port}/callback?code=${params.code}&state=${params.state}`;
  await new Promise<void>((resolve, reject) => {
    const req = http.request(url, { method: 'GET' }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 7. buildAuthorizeUrl — pure function
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  it('builds a correct authorize URL with all required params', () => {
    const url = buildAuthorizeUrl({
      serverUrl: 'https://mcp.example.com',
      clientId: 'client-123',
      redirectUri: 'http://127.0.0.1:54321/callback',
      codeChallenge: 'abc123',
      state: 'st-xyz',
    });

    expect(url).toContain('/oauth/authorize?');
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=client-123');
    expect(url).toContain(encodeURIComponent('http://127.0.0.1:54321/callback'));
    expect(url).toContain('code_challenge=abc123');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=st-xyz');
  });

  it('strips trailing slash from serverUrl', () => {
    const url = buildAuthorizeUrl({
      serverUrl: 'https://mcp.example.com/',
      clientId: 'c',
      redirectUri: 'http://127.0.0.1:1/callback',
      codeChallenge: 'c',
      state: 's',
    });
    expect(url).toContain('https://mcp.example.com/oauth/authorize');
    expect(url).not.toContain('//oauth/');
  });
});

// ---------------------------------------------------------------------------
// 8. validateState — pure function
// ---------------------------------------------------------------------------

describe('validateState', () => {
  it('returns true when states match', () => {
    expect(validateState('abc', 'abc')).toBe(true);
  });

  it('returns false when states differ', () => {
    expect(validateState('abc', 'xyz')).toBe(false);
  });

  it('returns false for empty vs non-empty', () => {
    expect(validateState('', 'abc')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared test runner that captures stdout/stderr without mocking process.exit.
// Instead of calling process.exit, we intercept it and record the code.
// Each test uses a fresh capture to avoid state leaking across tests.
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `runAuthCommand` with a mocked process.exit that records the code
 * and throws a sentinel so the async function unwinds cleanly.
 * The returned promise ALWAYS resolves (never rejects) with a RunResult.
 */
async function runWithCapture(
  args: string[],
  beforeRun?: () => void,
): Promise<RunResult> {
  const { runAuthCommand } = await import('../src/cli-auth.js');

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let exitCode = -1;

  class ExitSignal extends Error {
    constructor(public code: number) {
      super(`exit(${code})`);
    }
  }

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
    stdoutLines.push(typeof data === 'string' ? data : String(data));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
    stderrLines.push(typeof data === 'string' ? data : String(data));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number): never => {
    exitCode = code ?? 0;
    throw new ExitSignal(exitCode);
  });

  beforeRun?.();

  try {
    await runAuthCommand(args);
  } catch (e) {
    if (!(e instanceof ExitSignal)) {
      // Real unexpected error — still capture it
      stderrLines.push(e instanceof Error ? e.message : String(e));
      exitCode = 99;
    }
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return {
    stdout: stdoutLines.join(''),
    stderr: stderrLines.join(''),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// 6. Missing serverUrl
// ---------------------------------------------------------------------------

describe('runAuthCommand — missing serverUrl', () => {
  it('writes error to stderr and exits 1', async () => {
    const result = await runWithCapture([]);
    expect(result.stderr).toContain('Error: server URL is required');
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Loopback bind verification (US-13 AC-7 [threat-model])
// ---------------------------------------------------------------------------

describe('runAuthCommand — loopback bind (US-13 AC-7)', () => {
  it('calls server.listen with hostname "127.0.0.1"', async () => {
    const listenArgs: unknown[][] = [];

    const originalCreateServer = http.createServer.bind(http);
    const createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
      // @ts-ignore — spread on overloaded fn
      const realServer = originalCreateServer(...args);
      const originalListen = realServer.listen.bind(realServer);
      vi.spyOn(realServer, 'listen').mockImplementation((...listenCallArgs: unknown[]) => {
        listenArgs.push(listenCallArgs);
        // @ts-ignore — spread on overloaded fn
        return originalListen(...listenCallArgs);
      });
      return realServer;
    });

    // DCR succeeds so the command proceeds to listen and then waits for callback.
    // We trigger timeout via fake timers.
    fetchMock.mockResolvedValueOnce(makeFetchResponse({ client_id: 'test-client' }));

    vi.useFakeTimers();
    const resultPromise = runWithCapture(['http://localhost:9999']);
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await resultPromise;
    vi.useRealTimers();

    createServerSpy.mockRestore();

    // Verify listen was called with '127.0.0.1' as the hostname.
    expect(listenArgs.length).toBeGreaterThan(0);
    const firstListenCall = listenArgs[0];
    expect(firstListenCall).toBeDefined();
    // listen(port, hostname, cb) — hostname is arg[1]
    expect(firstListenCall![1]).toBe('127.0.0.1');

    // Also verify timeout behavior as a bonus.
    expect(result.stderr).toContain('Timeout');
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout — no callback within 120 s
// ---------------------------------------------------------------------------

describe('runAuthCommand — timeout', () => {
  it('writes "Timeout" to stderr and exits 1 when no callback arrives within 120 s', async () => {
    fetchMock.mockResolvedValueOnce(makeFetchResponse({ client_id: 'timeout-client' }));

    vi.useFakeTimers();
    const resultPromise = runWithCapture(['http://localhost:9999']);
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result.stderr).toContain('Timeout');
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('runAuthCommand — happy path', () => {
  it('prints "Access token: <token>" to stdout and exits 0', async () => {
    const expectedToken = 'tok-123';

    // We intercept fetch to capture the redirect URI from the DCR body,
    // then simulate the browser callback after server is up.
    let capturedRedirectUri = '';
    let capturedAuthUrl = '';

    const { exec: execMock } = await import('node:child_process');
    (execMock as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, cb?: (err: null, stdout: string, stderr: string) => void) => {
        const m = cmd.match(/"([^"]+)"/);
        if (m) capturedAuthUrl = m[1];
        if (cb) cb(null, '', '');
      },
    );

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      if (String(url).includes('/oauth/register')) {
        const body = JSON.parse(String(opts.body ?? '{}')) as { redirect_uris: string[] };
        capturedRedirectUri = body.redirect_uris[0] ?? '';
        return makeFetchResponse({ client_id: 'happy-client' });
      }
      // Token exchange
      return makeFetchResponse({ access_token: expectedToken, token_type: 'Bearer' });
    }) as unknown as typeof fetch;

    // Start command — it will block waiting for the callback.
    const resultPromise = runWithCapture(['http://localhost:9999']);

    // Poll until DCR fires and server is listening (redirect URI is captured).
    await waitForCondition(() => capturedRedirectUri !== '', 3000);

    // Parse port from redirect URI and state from auth URL.
    const redirectUrl = new URL(capturedRedirectUri);
    const port = Number(redirectUrl.port);

    // Wait a tick for exec mock to fire and capturedAuthUrl to be populated.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const authUrlParsed = new URL(capturedAuthUrl);
    const state = authUrlParsed.searchParams.get('state') ?? '';

    // Simulate browser hitting /callback.
    await hitCallback(port, { code: 'auth-code-abc', state });

    const result = await resultPromise;

    expect(result.stdout).toContain(`Access token: ${expectedToken}`);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. State mismatch
// ---------------------------------------------------------------------------

describe('runAuthCommand — state mismatch', () => {
  it('writes "State mismatch" to stderr and exits 1 when callback has wrong state', async () => {
    let capturedRedirectUri = '';

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      if (String(url).includes('/oauth/register')) {
        const body = JSON.parse(String(opts.body ?? '{}')) as { redirect_uris: string[] };
        capturedRedirectUri = body.redirect_uris[0] ?? '';
        return makeFetchResponse({ client_id: 'mismatch-client' });
      }
      return makeFetchResponse({ access_token: 'should-not-reach', token_type: 'Bearer' });
    }) as unknown as typeof fetch;

    const resultPromise = runWithCapture(['http://localhost:9999']);

    await waitForCondition(() => capturedRedirectUri !== '', 3000);

    const redirectUrl = new URL(capturedRedirectUri);
    const port = Number(redirectUrl.port);

    // Send callback with WRONG state.
    await hitCallback(port, { code: 'some-code', state: 'wrong-state-value' });

    const result = await resultPromise;

    expect(result.stderr).toContain('State mismatch');
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Token exchange error
// ---------------------------------------------------------------------------

describe('runAuthCommand — token exchange error', () => {
  it('writes error_description to stderr and exits 1 on PKCE failure', async () => {
    let capturedRedirectUri = '';
    let capturedAuthUrl = '';

    const { exec: execMock } = await import('node:child_process');
    (execMock as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, cb?: (err: null, stdout: string, stderr: string) => void) => {
        const m = cmd.match(/"([^"]+)"/);
        if (m) capturedAuthUrl = m[1];
        if (cb) cb(null, '', '');
      },
    );

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      if (String(url).includes('/oauth/register')) {
        const body = JSON.parse(String(opts.body ?? '{}')) as { redirect_uris: string[] };
        capturedRedirectUri = body.redirect_uris[0] ?? '';
        return makeFetchResponse({ client_id: 'pkce-client' });
      }
      // Token exchange fails.
      return makeFetchResponse(
        { error: 'invalid_grant', error_description: 'PKCE failed' },
        400,
      );
    }) as unknown as typeof fetch;

    const resultPromise = runWithCapture(['http://localhost:9999']);

    await waitForCondition(() => capturedRedirectUri !== '', 3000);

    const redirectUrl = new URL(capturedRedirectUri);
    const port = Number(redirectUrl.port);

    // Wait for exec mock to populate capturedAuthUrl.
    await waitForCondition(() => capturedAuthUrl !== '', 1000);

    const authUrlParsed = new URL(capturedAuthUrl);
    const state = authUrlParsed.searchParams.get('state') ?? '';

    await hitCallback(port, { code: 'bad-code', state });

    const result = await resultPromise;

    expect(result.stderr).toContain('PKCE failed');
    expect(result.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Poll until `condition()` returns true, or reject after `timeoutMs`. */
function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
      }
    }, 10);
  });
}
