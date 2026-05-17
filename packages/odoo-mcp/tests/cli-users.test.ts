import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runUsersCommand } from '../src/cli-users.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  // Reset env variable before each test
  delete process.env.MCP_ADMIN_PASSWORD;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Build a minimal Response-like object that satisfies the code under test.
 */
function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture process.exit calls so tests don't terminate the runner. */
function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
}

function mockStdout(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

function mockStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('runUsersCommand', () => {
  // 1. list --url ... --password ... → GET, correct URL, Authorization: Bearer
  it('list calls GET with Authorization: Bearer header and prints response body to stdout', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, '["user@example.com"]'));

    const stdoutSpy = mockStdout();

    await runUsersCommand(['list', '--url', 'http://localhost:3000', '--password', 'secret']);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://localhost:3000/admin/users');
    expect(calledInit.method).toBe('GET');
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');

    // Response body should have been written to stdout (pretty-printed JSON)
    expect(stdoutSpy).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls[0]?.[0] as string;
    expect(written).toContain('user@example.com');
  });

  // 2. allow user@example.com → POST, JSON body, Content-Type header
  it('allow calls POST with JSON body {"email":"user@example.com"} and Content-Type header', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(201, '{"ok":true}'));

    const stdoutSpy = mockStdout();

    await runUsersCommand([
      'allow',
      'user@example.com',
      '--url',
      'http://localhost:3000',
      '--password',
      'secret',
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://localhost:3000/admin/users');
    expect(calledInit.method).toBe('POST');
    expect(calledInit.body).toBe('{"email":"user@example.com"}');
    expect((calledInit.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(stdoutSpy).toHaveBeenCalled();
  });

  // 3. revoke user@example.com → DELETE, URL ending /admin/users/<email-encoded>
  it('revoke calls DELETE with URL-encoded email in path', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, '{"removed":true}'));

    mockStdout();

    await runUsersCommand([
      'revoke',
      'user@example.com',
      '--url',
      'http://localhost:3000',
      '--password',
      'secret',
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      `http://localhost:3000/admin/users/${encodeURIComponent('user@example.com')}`,
    );
    expect(calledInit.method).toBe('DELETE');
  });

  // 4. Missing --url → stderr "Error: --url is required", exit 1
  it('exits 1 with stderr error when --url is missing', async () => {
    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['list', '--password', 'secret']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('Error: --url is required');
  });

  // 5. Missing password (no flag, no env) → stderr error, exit 1
  it('exits 1 with stderr error when password is absent (no flag, no env)', async () => {
    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['list', '--url', 'http://localhost:3000']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('MCP_ADMIN_PASSWORD not set and --password not provided');
  });

  // 6. Password falls back to env when --password not provided
  it('uses MCP_ADMIN_PASSWORD env var when --password flag is absent', async () => {
    process.env.MCP_ADMIN_PASSWORD = 'env-password';
    fetchMock.mockResolvedValueOnce(makeResponse(200, '[]'));

    mockStdout();

    await runUsersCommand(['list', '--url', 'http://localhost:3000']);

    const [, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((calledInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer env-password',
    );
  });

  // 7. Non-2xx response (401) → body printed to stderr, exit 1
  it('exits 1 and prints body to stderr on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, 'Unauthorized'));

    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['list', '--url', 'http://localhost:3000', '--password', 'wrong']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('Unauthorized');
  });

  // 8. Unknown subcommand → stderr error, exit 1
  it('exits 1 with stderr error for an unknown subcommand', async () => {
    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['ban', '--url', 'http://localhost:3000', '--password', 'secret']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('Error: unknown subcommand: ban');
    expect(written).toContain('Expected: list, allow, revoke');
  });

  // 9. Missing email for allow → stderr error, exit 1
  it('exits 1 with stderr error when email is missing for allow', async () => {
    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['allow', '--url', 'http://localhost:3000', '--password', 'secret']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('Error: email argument required');
  });

  // Bonus: Missing email for revoke → stderr error, exit 1
  it('exits 1 with stderr error when email is missing for revoke', async () => {
    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['revoke', '--url', 'http://localhost:3000', '--password', 'secret']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('Error: email argument required');
  });

  // Bonus: Network error (fetch throws) → stderr "Network error: ...", exit 1
  it('exits 1 and prints "Network error: <msg>" to stderr when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const exitSpy = mockExit();
    const stderrSpy = mockStderr();

    await expect(
      runUsersCommand(['list', '--url', 'http://localhost:3000', '--password', 'secret']),
    ).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(written).toContain('Network error: ECONNREFUSED');
  });
});
