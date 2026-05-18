/**
 * Integration tests for http-transport.ts (T-04, T-11, T-17, T-18).
 *
 * Uses a real `startHttpTransport` instance bound to port 0 (OS-assigned),
 * with a mock McpServer and mock Logger. Exercises:
 *   - GET /health 200 (loopback, probe_ok=true) — all 6 fields
 *   - GET /health 503 (probe_ok=false)
 *   - POST /health → 405
 *   - POST /mcp no auth → 401
 *   - POST /mcp unknown token → 401
 *   - POST /mcp revoked user → 401
 *   - POST /mcp valid OAuth token → 200
 *   - GET /unknown-path with valid auth → 404
 *   - close() shuts down the listener
 *   - T-11: OAuth route dispatching, 64 KiB body limit
 *   - T-17: HSTS header, token-length warning, /health redaction,
 *            request_id propagation, XFF validation, TLS startup warning
 *   - T-18: auth-failure rate limiting (sliding 60 s window, 20-failure threshold)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock the StreamableHTTPServerTransport so we don't need a real MCP server.
// Mirrors the real SDK behaviour around session initialisation:
//   - sessionIdGenerator is called to mint an id on the FIRST handleRequest
//   - transport.sessionId is set to the minted id
//   - onsessioninitialized(id) is invoked synchronously
// Without this, the http-transport `sessions` Map never gets populated and
// the session-limit / session-lookup tests can't trigger their gates.
let mockSessionCounter = 0;
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
  interface MockTransportOpts {
    sessionIdGenerator?: () => string;
    onsessioninitialized?: (id: string) => void;
  }
  const MockTransport = vi.fn().mockImplementation((opts?: MockTransportOpts) => {
    const obj: {
      sessionId: string | undefined;
      onclose: (() => void) | undefined;
      handleRequest: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    } = {
      sessionId: undefined,
      onclose: undefined,
      handleRequest: vi.fn().mockImplementation(
        (_req: unknown, res: { writeHead: (s: number) => void; end: () => void }) => {
          // Fire session initialisation on the FIRST handleRequest call,
          // matching the real SDK's lazy id assignment.
          if (obj.sessionId === undefined) {
            const id = opts?.sessionIdGenerator
              ? opts.sessionIdGenerator()
              : `mock-sess-${++mockSessionCounter}`;
            obj.sessionId = id;
            opts?.onsessioninitialized?.(id);
          }
          res.writeHead(200);
          res.end();
          return Promise.resolve();
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    return obj;
  });

  return { StreamableHTTPServerTransport: MockTransport };
});

// Mock McpServer.connect so we can call it without a real Odoo server
const mockConnect = vi.fn().mockResolvedValue(undefined);
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const McpServer = vi.fn().mockImplementation(() => ({
    connect: mockConnect,
  }));
  return { McpServer };
});

import { startHttpTransport, getRequestContext, _MAX_SESSIONS, _AUTH_FAILURE_MAP_CAP } from '../src/http-transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpTransportConfig } from '../src/http-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    toolCall: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeHealthPayload(probe_ok = true) {
  return {
    mode: 'http' as const,
    odoo_url: 'https://erp.example.com',
    odoo_db: 'testdb',
    started_at: '2026-01-01T00:00:00.000Z',
    probe_ok,
  };
}

/**
 * Valid tokens accepted by the mock userStore.
 * VALID_TOKEN resolves to { email: 'user@example.com' } and isAllowed → true.
 */
const VALID_TOKEN = 't11-valid-oauth-token-abc123';
const VALID_EMAIL = 'user@example.com';

/** Build a mock OAuthEndpoints with spies on all handlers. */
function makeOAuthEndpoints() {
  return {
    handleMetadata: vi.fn().mockImplementation(
      (_req: unknown, res: { writeHead: (s: number) => void; end: (b: string) => void }) => {
        res.writeHead(200);
        res.end('{}');
      },
    ),
    handleRegister: vi.fn().mockImplementation(
      (_req: unknown, res: { writeHead: (s: number) => void; end: (b: string) => void }) => {
        res.writeHead(200);
        res.end('{}');
        return Promise.resolve();
      },
    ),
    handleAuthorize: vi.fn().mockImplementation(
      (_req: unknown, res: { writeHead: (s: number) => void; end: (b: string) => void }) => {
        res.writeHead(200);
        res.end('{}');
        return Promise.resolve();
      },
    ),
    handleToken: vi.fn().mockImplementation(
      (_req: unknown, res: { writeHead: (s: number) => void; end: (b: string) => void }) => {
        res.writeHead(200);
        res.end('{}');
        return Promise.resolve();
      },
    ),
  };
}

/** Build a mock AdminEndpoints with a spy on handleAdminUsers. */
function makeAdminEndpoints() {
  return {
    handleAdminUsers: vi.fn().mockImplementation(
      (_req: unknown, res: { writeHead: (s: number) => void; end: (b: string) => void }) => {
        res.writeHead(200);
        res.end('{}');
        return Promise.resolve();
      },
    ),
  };
}

/** Build a mock UserStore. resolveToken returns email for VALID_TOKEN, null otherwise. */
function makeUserStore(allowedEmails: string[] = [VALID_EMAIL]) {
  return {
    resolveToken: vi.fn().mockImplementation((token: string) => {
      if (token === VALID_TOKEN) return { email: VALID_EMAIL };
      return null;
    }),
    isAllowed: vi.fn().mockImplementation((email: string) => allowedEmails.includes(email)),
    allow: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue('new-token'),
    getCredentials: vi.fn().mockReturnValue(null),
    revokeTokensForUser: vi.fn(),
    listUsers: vi.fn().mockReturnValue([]),
    load: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a mock ClientCache. */
function makeClientCache() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    evict: vi.fn(),
    size: vi.fn().mockReturnValue(0),
    startSweep: vi.fn(),
    stopSweep: vi.fn(),
  };
}

/** Build a full HttpTransportConfig with all required mocks. */
function makeConfig(overrides: Partial<HttpTransportConfig> = {}): HttpTransportConfig {
  // createServerInstance returns a fresh mock server each call so the SDK
  // doesn't complain about "Already connected to a transport" mid-test.
  const createServerInstance = vi.fn(
    () =>
      ({ connect: mockConnect }) as unknown as ReturnType<HttpTransportConfig['createServerInstance']>,
  );
  return {
    port: 0,
    createServerInstance,
    logger: makeLogger(),
    healthPayload: makeHealthPayload(true),
    oauthEndpoints: makeOAuthEndpoints(),
    adminEndpoints: makeAdminEndpoints(),
    userStore: makeUserStore(),
    clientCache: makeClientCache(),
    ...overrides,
  };
}

/** Perform an HTTP request and return status + parsed JSON body. */
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let body: unknown = raw;
          try {
            body = JSON.parse(raw);
          } catch {
            // leave as raw string
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Like request() but also returns response headers and supports an optional
 * body payload (for testing POST body limits).
 */
function requestFull(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const extraHeaders: Record<string, string> = {};
    if (body !== undefined) {
      extraHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: { ...headers, ...extraHeaders } },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // leave as raw string
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: parsed,
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test suite — basic routing
// ---------------------------------------------------------------------------

describe('startHttpTransport', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  // -------------------------------------------------------------------------
  // /health — GET, probe_ok=true, loopback → 200 + all 6 fields
  // -------------------------------------------------------------------------
  it('GET /health from loopback returns 200 with all 6 fields when probe_ok=true', async () => {
    const { status, body } = await request(port, 'GET', '/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      mode: 'http',
      odoo_url: 'https://erp.example.com',
      odoo_db: 'testdb',
      probe_ok: true,
    });
    // started_at must be present
    expect(typeof (body as Record<string, unknown>)['started_at']).toBe('string');
  });

  // -------------------------------------------------------------------------
  // /health — POST → 405
  // -------------------------------------------------------------------------
  it('POST /health returns 405 method_not_allowed', async () => {
    const { status, body } = await request(port, 'POST', '/health');
    expect(status).toBe(405);
    expect(body).toEqual({ error: 'method_not_allowed' });
  });

  // -------------------------------------------------------------------------
  // /mcp — no Authorization header → 401
  // -------------------------------------------------------------------------
  it('POST /mcp with no Authorization header returns 401 unauthorized', async () => {
    const { status, body } = await request(port, 'POST', '/mcp');
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // /mcp — unknown token → 401
  // -------------------------------------------------------------------------
  it('POST /mcp with unknown token returns 401 unauthorized', async () => {
    const { status, body } = await request(port, 'POST', '/mcp', {
      Authorization: 'Bearer unknown-token-xyz',
    });
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // /mcp — malformed Authorization (no "Bearer " prefix) → 401
  // -------------------------------------------------------------------------
  it('POST /mcp with malformed auth (no Bearer prefix) returns 401', async () => {
    const { status, body } = await request(port, 'POST', '/mcp', {
      Authorization: VALID_TOKEN, // missing "Bearer " prefix
    });
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // /mcp — valid OAuth token → 200
  // -------------------------------------------------------------------------
  it('POST /mcp with valid OAuth token returns 200', async () => {
    const { status } = await request(port, 'POST', '/mcp', {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // unknown path with valid auth → 404
  // -------------------------------------------------------------------------
  it('GET /unknown-path with valid auth returns 404 not_found', async () => {
    const { status, body } = await request(port, 'GET', '/unknown-path', {
      Authorization: `Bearer ${VALID_TOKEN}`,
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// T-11: OAuth token validation scenarios
// ---------------------------------------------------------------------------

describe('T-11: OAuth token validation', () => {
  it('returns 401 when resolveToken returns null (unknown token)', async () => {
    const userStore = makeUserStore();
    userStore.resolveToken.mockReturnValue(null);

    const result = await startHttpTransport(makeConfig({ userStore }));
    const addr = result.httpServer.address() as AddressInfo;
    try {
      const { status, body } = await request(addr.port, 'POST', '/mcp', {
        Authorization: 'Bearer some-token',
      });
      expect(status).toBe(401);
      expect(body).toEqual({ error: 'unauthorized' });
    } finally {
      await result.close();
    }
  });

  it('returns 401 when resolveToken returns email but isAllowed returns false (revoked user)', async () => {
    const userStore = makeUserStore([]);  // empty allowed list → isAllowed returns false
    userStore.resolveToken.mockReturnValue({ email: VALID_EMAIL });

    const result = await startHttpTransport(makeConfig({ userStore }));
    const addr = result.httpServer.address() as AddressInfo;
    try {
      const { status, body } = await request(addr.port, 'POST', '/mcp', {
        Authorization: `Bearer ${VALID_TOKEN}`,
      });
      expect(status).toBe(401);
      expect(body).toEqual({ error: 'unauthorized' });
    } finally {
      await result.close();
    }
  });

  it('returns 200 when valid OAuth token resolves and user is allowed', async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    try {
      const { status } = await request(addr.port, 'POST', '/mcp', {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
      });
      expect(status).toBe(200);
    } finally {
      await result.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T-11: OAuth route dispatching
// ---------------------------------------------------------------------------

describe('T-11: OAuth and admin route dispatching', () => {
  let port: number;
  let close: () => Promise<void>;
  let oauthEndpoints: ReturnType<typeof makeOAuthEndpoints>;
  let adminEndpoints: ReturnType<typeof makeAdminEndpoints>;

  beforeAll(async () => {
    oauthEndpoints = makeOAuthEndpoints();
    adminEndpoints = makeAdminEndpoints();
    const result = await startHttpTransport(makeConfig({ oauthEndpoints, adminEndpoints }));
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  it('GET /.well-known/oauth-authorization-server dispatches to oauthEndpoints.handleMetadata', async () => {
    const { status } = await request(port, 'GET', '/.well-known/oauth-authorization-server');
    expect(status).toBe(200);
    expect(oauthEndpoints.handleMetadata).toHaveBeenCalledTimes(1);
  });

  it('POST /oauth/register dispatches to oauthEndpoints.handleRegister', async () => {
    const { status } = await request(port, 'POST', '/oauth/register');
    expect(status).toBe(200);
    expect(oauthEndpoints.handleRegister).toHaveBeenCalledTimes(1);
  });

  it('POST /oauth/authorize dispatches to oauthEndpoints.handleAuthorize', async () => {
    const { status } = await request(port, 'POST', '/oauth/authorize');
    expect(status).toBe(200);
    expect(oauthEndpoints.handleAuthorize).toHaveBeenCalledTimes(1);
  });

  it('POST /oauth/token dispatches to oauthEndpoints.handleToken', async () => {
    const { status } = await request(port, 'POST', '/oauth/token');
    expect(status).toBe(200);
    expect(oauthEndpoints.handleToken).toHaveBeenCalledTimes(1);
  });

  it('POST /admin/users dispatches to adminEndpoints.handleAdminUsers', async () => {
    const { status } = await request(port, 'POST', '/admin/users');
    expect(status).toBe(200);
    expect(adminEndpoints.handleAdminUsers).toHaveBeenCalledTimes(1);
  });

  it('GET /.well-known/oauth-authorization-server does not require auth', async () => {
    // No Authorization header — should still succeed
    const { status } = await request(port, 'GET', '/.well-known/oauth-authorization-server');
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Separate server instance: probe_ok=false → 503
// ---------------------------------------------------------------------------
describe('startHttpTransport — probe_ok=false', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig({ healthPayload: makeHealthPayload(false) }));
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  it('GET /health returns 503 when probe_ok=false', async () => {
    const { status, body } = await request(port, 'GET', '/health');
    expect(status).toBe(503);
    expect((body as Record<string, unknown>)['ok']).toBe(false);
    expect((body as Record<string, unknown>)['probe_ok']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// close() shuts down the listener
// ---------------------------------------------------------------------------
describe('startHttpTransport — close()', () => {
  it('close() resolves and server stops accepting connections', async () => {
    const { httpServer, close } = await startHttpTransport(makeConfig());
    const addr = httpServer.address() as AddressInfo;
    const p = addr.port;

    // Server is up — health should respond
    const { status } = await request(p, 'GET', '/health');
    expect(status).toBe(200);

    // Close the server
    await close();

    // Server should now refuse connections
    await expect(request(p, 'GET', '/health')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getRequestContext — unit test (no real server needed)
// ---------------------------------------------------------------------------
describe('getRequestContext', () => {
  it('returns undefined for a transport with no attached context', () => {
    const transport = new StreamableHTTPServerTransport();
    expect(getRequestContext(transport)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-17 hardening behaviors
// ---------------------------------------------------------------------------

// ---- 1. HSTS header -------------------------------------------------------
describe('T-17: HSTS header (US-1 AC-9)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => { await close(); });

  it('includes HSTS header when X-Forwarded-Proto is https', async () => {
    const { headers } = await requestFull(port, 'GET', '/health', {
      'X-Forwarded-Proto': 'https',
    });
    expect(headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(headers['strict-transport-security']).toContain('includeSubDomains');
  });

  it('does NOT include HSTS header when request is plain HTTP (no X-Forwarded-Proto)', async () => {
    const { headers } = await requestFull(port, 'GET', '/health');
    expect(headers['strict-transport-security']).toBeUndefined();
  });
});

// ---- 2. 64 KiB body limit ---------------------------------------------------
describe('T-11: 64 KiB body limit (US-1 AC-8 / US-11 AC-8 [threat-model])', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => { await close(); });

  it('returns 413 when Content-Length header exceeds 64 KiB', async () => {
    const { status, body } = await requestFull(
      port,
      'POST',
      '/mcp',
      {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': String(65_537),
        Connection: 'close',
      },
    );
    expect(status).toBe(413);
    expect((body as Record<string, unknown>)['error']).toBe('payload_too_large');
  });

  it('accepts a body just under 64 KiB (65 535 bytes)', async () => {
    // Server-side body parsing (MCP SDK requires pre-parsed JSON) now means
    // the body must be valid JSON. Build a payload whose stringified length
    // is exactly under the 64 KiB cap.
    const filler = 'x'.repeat(65_535 - 32);
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', _f: filler }));
    expect(payload.length).toBeLessThanOrEqual(65_535);
    const { status } = await requestFull(
      port,
      'POST',
      '/mcp',
      {
        Authorization: `Bearer ${VALID_TOKEN}`,
        'Content-Type': 'application/json',
        Connection: 'close',
      },
      payload,
    );
    expect(status).toBe(200);
  });
});

// ---- 3. Loopback /health redaction ----------------------------------------
describe('T-17: /health loopback redaction (US-3 AC-7)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => { await close(); });

  it('returns full payload with odoo_url for loopback caller (::ffff:127.0.0.1)', async () => {
    const { status, body } = await request(port, 'GET', '/health');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['odoo_url']).toBe('https://erp.example.com');
    expect(b['odoo_db']).toBe('testdb');
  });

  it('includes all 6 health fields for loopback caller', async () => {
    const { status, body } = await request(port, 'GET', '/health');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['ok']).toBe(true);
    expect(b['mode']).toBe('http');
    expect(typeof b['odoo_url']).toBe('string');
    expect(typeof b['odoo_db']).toBe('string');
    expect(typeof b['started_at']).toBe('string');
    expect(b['probe_ok']).toBe(true);
  });

  it('redacts payload when loopback caller adds X-Forwarded-For (no trustProxy)', async () => {
    const { status, body } = await request(port, 'GET', '/health', {
      'X-Forwarded-For': '8.8.8.8',
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['odoo_url']).toBeUndefined();
    expect(b['odoo_db']).toBeUndefined();
    expect(b['ok']).toBe(true);
    expect(b['mode']).toBe('http');
    expect(b['probe_ok']).toBe(true);
  });
});

describe('/health redaction with MCP_TRUST_PROXY=true (proxy-fronted)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig({ trustProxy: true }));
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  it('returns FULL payload when XFF first-hop is loopback (true local through proxy)', async () => {
    const { status, body } = await request(port, 'GET', '/health', {
      'X-Forwarded-For': '127.0.0.1',
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['odoo_url']).toBe('https://erp.example.com');
    expect(b['odoo_db']).toBe('testdb');
  });

  it('REDACTS payload when XFF first-hop is external (real-world Caddy scenario)', async () => {
    const { status, body } = await request(port, 'GET', '/health', {
      'X-Forwarded-For': '203.0.113.45, 127.0.0.1',
    });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['odoo_url']).toBeUndefined();
    expect(b['odoo_db']).toBeUndefined();
    expect(b['ok']).toBe(true);
    expect(b['mode']).toBe('http');
    expect(b['probe_ok']).toBe(true);
  });

  it('returns FULL payload when no XFF present even with trustProxy=true (direct loopback)', async () => {
    const { status, body } = await request(port, 'GET', '/health');
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['odoo_url']).toBe('https://erp.example.com');
  });
});

// ---- 4. request_id propagation --------------------------------------------
describe('T-17: request_id UUIDv4 propagation (US-4 AC-7)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => { await close(); });

  it('logs a request_id in the http_request log line for /mcp', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    await requestFull(port, 'POST', '/mcp', {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    });

    spy.mockRestore();

    const uuidV4Re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    const mcpLog = stderrLines.find((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed['event'] === 'http_request' && parsed['path'] === '/mcp';
      } catch {
        return false;
      }
    });
    expect(mcpLog).toBeDefined();
    const parsed = JSON.parse(mcpLog ?? '{}') as Record<string, unknown>;
    expect(typeof parsed['request_id']).toBe('string');
    expect(uuidV4Re.test(String(parsed['request_id']))).toBe(true);
  });

  it('/health request does NOT have a request_id in the log line', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    await requestFull(port, 'GET', '/health');
    spy.mockRestore();

    const healthLog = stderrLines.find((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed['event'] === 'http_request' && parsed['path'] === '/health';
      } catch {
        return false;
      }
    });
    expect(healthLog).toBeDefined();
    const parsed = JSON.parse(healthLog ?? '{}') as Record<string, unknown>;
    expect(parsed['request_id']).toBeUndefined();
  });
});

// ---- 5. XFF character validation ------------------------------------------
describe('T-17: XFF character validation (US-4 AC-8)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => { await close(); });

  it('uses first valid XFF entry as client_ip in the request log', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    await requestFull(port, 'GET', '/health', {
      'X-Forwarded-For': '10.0.0.1, 192.168.1.1',
    });
    spy.mockRestore();

    const log = stderrLines.find((line) => {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        return p['event'] === 'http_request' && p['path'] === '/health';
      } catch { return false; }
    });
    expect(log).toBeDefined();
    const p = JSON.parse(log ?? '{}') as Record<string, unknown>;
    expect(p['client_ip']).toBe('10.0.0.1');
  });

  it('sets client_ip to "invalid" when XFF contains non-IP characters (parens)', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    await requestFull(port, 'GET', '/health', {
      'X-Forwarded-For': '10.0.0.1(evil)',
    });
    spy.mockRestore();

    const log = stderrLines.find((line) => {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        return p['event'] === 'http_request' && p['path'] === '/health';
      } catch { return false; }
    });
    expect(log).toBeDefined();
    const p = JSON.parse(log ?? '{}') as Record<string, unknown>;
    expect(p['client_ip']).toBe('invalid');
  });

  it('sets client_ip to "invalid" when XFF contains script tags', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    await requestFull(port, 'GET', '/health', {
      'X-Forwarded-For': '<script>alert(1)</script>',
    });
    spy.mockRestore();

    const log = stderrLines.find((line) => {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        return p['event'] === 'http_request' && p['path'] === '/health';
      } catch { return false; }
    });
    expect(log).toBeDefined();
    const p = JSON.parse(log ?? '{}') as Record<string, unknown>;
    expect(p['client_ip']).toBe('invalid');
  });
});

// ---- 6. TLS startup warning -----------------------------------------------
describe('T-17: TLS startup warning (US-1 AC-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits TLS warning after 60 s when no https-proxied request is received', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    const result = await startHttpTransport(makeConfig());

    // No https request sent — advance 60 s to trigger the warning
    await vi.advanceTimersByTimeAsync(60_001);

    await result.close();
    spy.mockRestore();

    const hasTlsWarning = stderrLines.some((line) => {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        return (
          p['event'] === 'warning' &&
          String(p['message']).toLowerCase().includes('tls')
        );
      } catch { return false; }
    });
    expect(hasTlsWarning).toBe(true);
  });

  it('does NOT emit TLS warning when an https-proxied request arrives within 60 s', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;

    // Send a real https-proxied request (sets tlsSeen = true).
    vi.useRealTimers();
    await requestFull(addr.port, 'GET', '/health', {
      'X-Forwarded-Proto': 'https',
    });
    vi.useFakeTimers();

    // Advance past the 60 s window — warning should NOT fire because tlsSeen=true
    await vi.advanceTimersByTimeAsync(60_001);

    vi.useRealTimers();
    await result.close();
    vi.useFakeTimers();
    spy.mockRestore();

    const hasTlsWarning = stderrLines.some((line) => {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        return (
          p['event'] === 'warning' &&
          String(p['message']).toLowerCase().includes('tls')
        );
      } catch { return false; }
    });
    expect(hasTlsWarning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-18: auth-failure rate limiting
// ---------------------------------------------------------------------------

describe('auth failure rate limit', () => {
  // Each test uses a dedicated server instance to get a fresh rate-limit state.
  // The authFailures Map is module-level, keyed by IP. We use unique IPs per
  // test to avoid cross-test contamination without needing module reloads.

  // Helper: spin up a fresh server, run fn, then close.
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    try {
      await fn(addr.port);
    } finally {
      await result.close();
    }
  }

  /** Send a bad-auth POST from a given XFF IP. */
  function badAuth(port: number, ip: string): Promise<{ status: number; body: unknown }> {
    return requestFull(port, 'POST', '/mcp', {
      Authorization: 'Bearer wrong-token',
      'X-Forwarded-For': ip,
    });
  }

  it('returns 401 for 19 consecutive failures from the same IP (below threshold)', async () => {
    await withServer(async (port) => {
      for (let i = 0; i < 19; i++) {
        const { status } = await badAuth(port, '192.0.2.10');
        expect(status).toBe(401);
      }
    });
  });

  it('returns 429 on the 21st request after 20 auth failures within 60 s', async () => {
    await withServer(async (port) => {
      // 20 consecutive failures — all within the same real-time 60 s window
      for (let i = 0; i < 20; i++) {
        await badAuth(port, '192.0.2.11');
      }
      // 21st request must be rate-limited
      const { status, body } = await badAuth(port, '192.0.2.11');
      expect(status).toBe(429);
      expect((body as Record<string, unknown>)['error']).toBe('rate_limited');
    });
  });

  it('resets rate limit after the 60 s window slides (via fake system time)', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    try {
      await withServer(async (port) => {
        // Record 20 failures at fake time t0
        for (let i = 0; i < 20; i++) {
          await badAuth(port, '192.0.2.12');
        }
        // Advance fake clock by 61 s — all stored timestamps are now > 60 s old
        vi.setSystemTime(t0 + 61_000);

        // Next request should be 401 (window slid, failures pruned)
        const { status } = await badAuth(port, '192.0.2.12');
        expect(status).toBe(401);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('failures from one IP do not affect a different IP', async () => {
    await withServer(async (port) => {
      // Saturate IP_A (192.0.2.20) past the threshold
      for (let i = 0; i < 21; i++) {
        await badAuth(port, '192.0.2.20');
      }
      // Verify IP_A is now blocked
      const { status: blocked } = await badAuth(port, '192.0.2.20');
      expect(blocked).toBe(429);

      // IP_B (192.0.2.21) must still be 401 — not contaminated
      const { status: ok } = await badAuth(port, '192.0.2.21');
      expect(ok).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// F-003: session limit
// ---------------------------------------------------------------------------

describe('session limit (F-003)', () => {
  // Override MockTransport so each instance gets a unique sessionId.
  let sessionCounter = 0;

  beforeEach(() => {
    sessionCounter = 0;
    vi.mocked(StreamableHTTPServerTransport).mockImplementation(
      (opts?: { sessionIdGenerator?: () => string; onsessioninitialized?: (id: string) => void }) => {
        const obj: {
          sessionId: string | undefined;
          onclose: (() => void) | undefined;
          handleRequest: ReturnType<typeof vi.fn>;
          close: ReturnType<typeof vi.fn>;
          connect: ReturnType<typeof vi.fn>;
          start: ReturnType<typeof vi.fn>;
          send: ReturnType<typeof vi.fn>;
        } = {
          sessionId: undefined,
          onclose: undefined,
          handleRequest: vi.fn().mockImplementation(
            (_req: unknown, res: { writeHead: (s: number) => void; end: () => void }) => {
              if (obj.sessionId === undefined) {
                const id = opts?.sessionIdGenerator?.() ?? `sess-${++sessionCounter}`;
                obj.sessionId = id;
                opts?.onsessioninitialized?.(id);
              }
              res.writeHead(200);
              res.end();
              return Promise.resolve();
            },
          ),
          close: vi.fn().mockImplementation(async () => {
            if (obj.onclose) obj.onclose();
          }),
          connect: vi.fn().mockResolvedValue(undefined),
          start: vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockResolvedValue(undefined),
        };
        return obj;
      },
    );
  });

  afterEach(() => {
    vi.mocked(StreamableHTTPServerTransport).mockImplementation(() => ({
      sessionId: undefined as string | undefined,
      onclose: undefined as (() => void) | undefined,
      handleRequest: vi.fn().mockImplementation(
        (_req: unknown, res: { writeHead: (s: number) => void; end: () => void }) => {
          res.writeHead(200);
          res.end();
          return Promise.resolve();
        },
      ),
      close: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    }));
  });

  /** Send a new-session POST (no Mcp-Session-Id header). */
  function newSession(port: number): Promise<{ status: number; body: unknown }> {
    return requestFull(port, 'POST', '/mcp', {
      Authorization: `Bearer ${VALID_TOKEN}`,
      'Content-Type': 'application/json',
    });
  }

  it('returns 503 too_many_sessions when MAX_SESSIONS sessions exist', async () => {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    const port = addr.port;

    try {
      // Fill up to MAX_SESSIONS sessions
      for (let i = 0; i < _MAX_SESSIONS; i++) {
        await newSession(port);
      }

      // The next new-session request must be rejected
      const { status, body } = await newSession(port);
      expect(status).toBe(503);
      expect((body as Record<string, unknown>)['error']).toBe('too_many_sessions');
    } finally {
      await result.close();
    }
  });

  it('allows a new session after an existing session closes', async () => {
    const transports: Array<{ sessionId: string | undefined; onclose: (() => void) | undefined; close: () => Promise<void> }> = [];

    vi.mocked(StreamableHTTPServerTransport).mockImplementation(
      (opts?: { sessionIdGenerator?: () => string; onsessioninitialized?: (id: string) => void }) => {
        const obj: {
          sessionId: string | undefined;
          onclose: (() => void) | undefined;
          handleRequest: ReturnType<typeof vi.fn>;
          close: ReturnType<typeof vi.fn>;
          connect: ReturnType<typeof vi.fn>;
          start: ReturnType<typeof vi.fn>;
          send: ReturnType<typeof vi.fn>;
        } = {
          sessionId: undefined,
          onclose: undefined,
          handleRequest: vi.fn().mockImplementation(
            (_req: unknown, res: { writeHead: (s: number) => void; end: () => void }) => {
              if (obj.sessionId === undefined) {
                const id = opts?.sessionIdGenerator?.() ?? `sess-close-${++sessionCounter}`;
                obj.sessionId = id;
                opts?.onsessioninitialized?.(id);
              }
              res.writeHead(200);
              res.end();
              return Promise.resolve();
            },
          ),
          close: vi.fn().mockImplementation(async () => {
            if (obj.onclose) obj.onclose();
          }),
          connect: vi.fn().mockResolvedValue(undefined),
          start: vi.fn().mockResolvedValue(undefined),
          send: vi.fn().mockResolvedValue(undefined),
        };
        transports.push(obj);
        return obj;
      },
    );

    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    const port = addr.port;

    try {
      // Fill to MAX_SESSIONS
      for (let i = 0; i < _MAX_SESSIONS; i++) {
        await newSession(port);
      }

      // Verify cap is hit
      const { status: before } = await newSession(port);
      expect(before).toBe(503);

      // Close the first session — triggers onclose which removes it from sessions map
      const first = transports[0];
      if (first) {
        await first.close();
      }

      // Now a new session should be accepted (count is MAX_SESSIONS - 1)
      const { status: after } = await newSession(port);
      expect(after).toBe(200);
    } finally {
      await result.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F-004: authFailures Map bounds
// ---------------------------------------------------------------------------

describe('authFailures map bounds (F-004)', () => {
  async function withBoundsServer(fn: (port: number) => Promise<void>): Promise<void> {
    const result = await startHttpTransport(makeConfig());
    const addr = result.httpServer.address() as AddressInfo;
    try {
      await fn(addr.port);
    } finally {
      await result.close();
    }
  }

  function badAuthFrom(port: number, ip: string): Promise<{ status: number }> {
    return requestFull(port, 'POST', '/mcp', {
      Authorization: 'Bearer wrong-token',
      'X-Forwarded-For': ip,
    });
  }

  it('prunes entries whose newest failure is older than 60 s (sweep interval)', async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    try {
      await withBoundsServer(async (port) => {
        // Add a few failures at t0
        await badAuthFrom(port, '10.1.0.1');
        await badAuthFrom(port, '10.1.0.2');

        // Advance time by 61 s — failures are now older than AUTH_FAILURE_SWEEP_MAX_AGE_MS
        vi.setSystemTime(t0 + 61_000);

        // Advance fake timers by 5 min + 1 ms to trigger the sweep
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

        for (let i = 0; i < 20; i++) {
          await badAuthFrom(port, '10.1.0.3');
        }
        const { status } = await badAuthFrom(port, '10.1.0.3');
        expect(status).toBe(429);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts oldest 25% when Map size exceeds AUTH_FAILURE_MAP_CAP', async () => {
    vi.useFakeTimers();
    try {
      await withBoundsServer(async (port) => {
        const cap = _AUTH_FAILURE_MAP_CAP;

        for (let i = 0; i < cap + 1; i++) {
          const a = Math.floor(i / 65536) % 256;
          const b = Math.floor(i / 256) % 256;
          const c = i % 256;
          const ip = `10.${a}.${b}.${c}`;
          await badAuthFrom(port, ip);
        }

        const { status } = await requestFull(port, 'GET', '/health');
        expect(status).toBe(200);

        for (let i = 0; i < 20; i++) {
          await badAuthFrom(port, '203.0.113.99');
        }
        const { status: rateLimited } = await badAuthFrom(port, '203.0.113.99');
        expect(rateLimited).toBe(429);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
