/**
 * Integration tests for http-transport.ts (T-04).
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
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { startHttpTransport, getRequestContext } from '../src/http-transport.js';
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
