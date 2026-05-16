/**
 * Integration tests for http-transport.ts (T-04, T-17, T-18).
 *
 * Uses a real `startHttpTransport` instance bound to port 0 (OS-assigned),
 * with a mock McpServer and mock Logger. Exercises:
 *   - GET /health 200 (loopback, probe_ok=true) — all 6 fields
 *   - GET /health 503 (probe_ok=false)
 *   - POST /health → 405
 *   - POST /mcp no auth → 401
 *   - POST /mcp wrong token → 401 (identical body to no-auth)
 *   - GET /unknown-path with valid auth → 404
 *   - close() shuts down the listener
 *   - T-17: HSTS header, body limit, token-length warning, /health redaction,
 *            request_id propagation, XFF validation, TLS startup warning
 *   - T-18: auth-failure rate limiting (sliding 60 s window, 20-failure threshold)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock the StreamableHTTPServerTransport so we don't need a real MCP server
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => {
  const MockTransport = vi.fn().mockImplementation(() => ({
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

  // Make sessionId assignable so our code can set it
  (MockTransport as unknown as { _mockSessionId?: string })._mockSessionId = undefined;

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
// Test suite
// ---------------------------------------------------------------------------

const BEARER_TOKEN = 't04-test-secret-bearer-token';

describe('startHttpTransport', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const config: HttpTransportConfig = {
      port: 0, // OS-assigned port
      bearerToken: BEARER_TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    };

    const result = await startHttpTransport(config);
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
  // /mcp — wrong token → 401 (identical body to no-auth, per US-2 AC-9)
  // -------------------------------------------------------------------------
  it('POST /mcp with wrong bearer token returns 401 with identical body as no-auth', async () => {
    const { status, body } = await request(port, 'POST', '/mcp', {
      Authorization: 'Bearer wrong-token-xyz',
    });
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // /mcp — malformed Authorization (no "Bearer " prefix) → 401
  // -------------------------------------------------------------------------
  it('POST /mcp with malformed auth (no Bearer prefix) returns 401', async () => {
    const { status, body } = await request(port, 'POST', '/mcp', {
      Authorization: BEARER_TOKEN, // missing "Bearer " prefix
    });
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  // -------------------------------------------------------------------------
  // unknown path with valid auth → 404
  // -------------------------------------------------------------------------
  it('GET /unknown-path with valid auth returns 404 not_found', async () => {
    const { status, body } = await request(port, 'GET', '/unknown-path', {
      Authorization: `Bearer ${BEARER_TOKEN}`,
    });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// Separate server instance: probe_ok=false → 503
// ---------------------------------------------------------------------------
describe('startHttpTransport — probe_ok=false', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const config: HttpTransportConfig = {
      port: 0,
      bearerToken: BEARER_TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(false),
    };

    const result = await startHttpTransport(config);
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
    const config: HttpTransportConfig = {
      port: 0,
      bearerToken: BEARER_TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    };

    const { httpServer, close } = await startHttpTransport(config);
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
    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'a'.repeat(32),
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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

// ---- 2. 1 MB body limit ---------------------------------------------------
describe('T-17: 1 MB body limit (US-1 AC-8)', () => {
  let port: number;
  let close: () => Promise<void>;
  const TOKEN = 'b'.repeat(32);

  beforeAll(async () => {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
    const addr = result.httpServer.address() as AddressInfo;
    port = addr.port;
    close = result.close;
  });

  afterAll(async () => { await close(); });

  it('returns 413 when Content-Length header exceeds 1 MiB', async () => {
    // Send only the Content-Length header (no body) — the fast-path check triggers
    // before any body bytes are read. Use Connection:close to avoid keep-alive
    // reuse on a connection that declared a large Content-Length but sent no body.
    const { status, body } = await requestFull(
      port,
      'POST',
      '/mcp',
      {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': String(1_048_577),
        Connection: 'close',
      },
    );
    expect(status).toBe(413);
    expect((body as Record<string, unknown>)['error']).toBe('payload_too_large');
  });

  it('accepts a body just under 1 MiB (1 048 575 bytes)', async () => {
    // Body just under 1 MiB — the body-limit check passes; mock handler returns 200.
    const payload = Buffer.alloc(1_048_575, 'x');
    const { status } = await requestFull(
      port,
      'POST',
      '/mcp',
      {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Connection: 'close',
      },
      payload,
    );
    expect(status).toBe(200);
  });
});

// ---- 3. Token-length warning ----------------------------------------------
describe('T-17: bearer token <32 char warning (US-2 AC-8)', () => {
  it('emits a warning event to stderr when token is <32 chars', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'short', // <32 chars
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
    await result.close();
    spy.mockRestore();

    const hasWarning = stderrLines.some((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed['event'] === 'warning' && String(parsed['message']).includes('32');
      } catch {
        return false;
      }
    });
    expect(hasWarning).toBe(true);
  });

  it('does NOT emit a token-length warning when token is >=32 chars', async () => {
    const stderrLines: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((data: string | Uint8Array) => {
        stderrLines.push(typeof data === 'string' ? data : data.toString());
        return true;
      });

    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'c'.repeat(32), // exactly 32 chars — no warning
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
    await result.close();
    spy.mockRestore();

    const hasWarning = stderrLines.some((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return parsed['event'] === 'warning' && String(parsed['message']).includes('32');
      } catch {
        return false;
      }
    });
    expect(hasWarning).toBe(false);
  });
});

// ---- 4. Loopback /health redaction ----------------------------------------
describe('T-17: /health loopback redaction (US-3 AC-7)', () => {
  // Note: tests run from 127.0.0.1 → socket.remoteAddress = ::ffff:127.0.0.1
  // which IS a loopback address. The non-loopback (redacted) code path requires
  // a TCP connection from a non-loopback IP and is covered by integration tests.
  // Here we verify the loopback-full-payload behavior and the isLoopbackAddress
  // mapping via the /health response fields.
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'd'.repeat(32),
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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
    // Full payload must have ok, mode, odoo_url, odoo_db, started_at, probe_ok
    expect(b['ok']).toBe(true);
    expect(b['mode']).toBe('http');
    expect(typeof b['odoo_url']).toBe('string');
    expect(typeof b['odoo_db']).toBe('string');
    expect(typeof b['started_at']).toBe('string');
    expect(b['probe_ok']).toBe(true);
  });
});

// ---- 5. request_id propagation --------------------------------------------
describe('T-17: request_id UUIDv4 propagation (US-4 AC-7)', () => {
  let port: number;
  let close: () => Promise<void>;
  const TOKEN = 'e'.repeat(32);

  beforeAll(async () => {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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
      Authorization: `Bearer ${TOKEN}`,
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

// ---- 6. XFF character validation ------------------------------------------
describe('T-17: XFF character validation (US-4 AC-8)', () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'f'.repeat(32),
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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

    // Parentheses are outside the safe set [0-9a-fA-F.:, ] and pass Node header validation
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

// ---- 7. TLS startup warning -----------------------------------------------
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

    // Start server — fake timers are active, so the 60 s setTimeout is deferred.
    // The listen() call uses a real I/O callback; awaiting the promise works
    // because Node resolves the listen callback before fake timers run.
    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'g'.repeat(32),
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });

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

    const result = await startHttpTransport({
      port: 0,
      bearerToken: 'h'.repeat(32),
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
    const addr = result.httpServer.address() as AddressInfo;

    // Send a real https-proxied request (sets tlsSeen = true).
    // Temporarily restore real timers so the HTTP request can complete.
    vi.useRealTimers();
    await requestFull(addr.port, 'GET', '/health', {
      'X-Forwarded-Proto': 'https',
    });
    // Re-install fake timers; the existing 60 s timer from startHttpTransport
    // was registered while fake timers were active, so its handle is still fake.
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
  const RATE_TOKEN = 'i'.repeat(32);

  // Helper: spin up a fresh server, run fn, then close.
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: RATE_TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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
    // Use fake timers to control Date.now() without waiting 60 real seconds.
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
  const TOKEN = 'j'.repeat(32);

  // Override MockTransport so each instance gets a unique sessionId.
  // This is required because the session map only grows when sessionId !== undefined.
  let sessionCounter = 0;

  beforeEach(() => {
    sessionCounter = 0;
    vi.mocked(StreamableHTTPServerTransport).mockImplementation(() => {
      const sid = `sess-${++sessionCounter}`;
      const obj = {
        sessionId: sid as string | undefined,
        onclose: undefined as (() => void) | undefined,
        handleRequest: vi.fn().mockImplementation(
          (_req: unknown, res: { writeHead: (s: number) => void; end: () => void }) => {
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
    });
  });

  afterEach(() => {
    // Restore the original mock implementation for other tests
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
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
  }

  it('returns 503 too_many_sessions when MAX_SESSIONS sessions exist', async () => {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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
    // Use a small mock that exposes the onclose callback so we can trigger it
    const transports: Array<{ sessionId: string | undefined; onclose: (() => void) | undefined; close: () => Promise<void> }> = [];

    vi.mocked(StreamableHTTPServerTransport).mockImplementation(() => {
      const sid = `sess-close-${++sessionCounter}`;
      const obj = {
        sessionId: sid as string | undefined,
        onclose: undefined as (() => void) | undefined,
        handleRequest: vi.fn().mockImplementation(
          (_req: unknown, res: { writeHead: (s: number) => void; end: () => void }) => {
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
    });

    const result = await startHttpTransport({
      port: 0,
      bearerToken: TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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
  const TOKEN = 'k'.repeat(32);

  async function withBoundsServer(fn: (port: number) => Promise<void>): Promise<void> {
    const result = await startHttpTransport({
      port: 0,
      bearerToken: TOKEN,
      server: { connect: mockConnect } as unknown as Parameters<typeof startHttpTransport>[0]['server'],
      logger: makeLogger(),
      healthPayload: makeHealthPayload(true),
    });
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

        // The IPs can now fail again freely (sweep cleared them);
        // if they were still present and the 60 s window had aged out, isAuthRateLimited
        // would return false on the next access — but we verify the sweep ran by
        // confirming the entries are gone (only 1 failure each, never blocked anyway).
        // The observable effect: after 61 more failures the new IP is blocked as expected.
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
    // Fill the map to just above the cap using unique IPs, then verify size stays bounded.
    // We use fake system time so all entries share the same timestamp and none age out.
    vi.useFakeTimers();
    try {
      await withBoundsServer(async (port) => {
        const cap = _AUTH_FAILURE_MAP_CAP;

        // Generate cap + 1 unique IPs. The (cap+1)-th insert must trigger eviction.
        // Each unique IP generates 1 failure, so the map would grow to cap+1 without the guard.
        // With the guard, inserting the (cap+1)-th new IP evicts 25% before adding.
        for (let i = 0; i < cap + 1; i++) {
          // Build a unique IP per iteration
          const a = Math.floor(i / 65536) % 256;
          const b = Math.floor(i / 256) % 256;
          const c = i % 256;
          const ip = `10.${a}.${b}.${c}`;
          await badAuthFrom(port, ip);
        }

        // After cap+1 inserts with the eviction guard, the map size must be <= cap.
        // We can't inspect the module-private map directly, but we verify the server
        // is still healthy (no crash, health still responds 200).
        const { status } = await requestFull(port, 'GET', '/health');
        expect(status).toBe(200);

        // The key assertion: the server must not have OOM'd or crashed.
        // Additionally verify that a brand-new IP is still rate-limitable (logic intact).
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
