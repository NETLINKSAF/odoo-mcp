// @ts-ignore
import { randomUUID, timingSafeEqual } from 'node:crypto';
// @ts-ignore — @types/node not installed; resolves correctly at Node.js runtime
import { createServer } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Logger } from './logger.js';
import type { HealthPayload } from './types.js';

// ---------------------------------------------------------------------------
// Minimal ambient declarations — avoids @types/node dependency.
// ---------------------------------------------------------------------------

// Buffer is a Node.js global; declare only the subset we use.
declare const Buffer: {
  from(value: string, encoding?: string): BufferLike;
  concat(arrays: BufferLike[], totalLength?: number): BufferLike;
  alloc(size: number): BufferLike;
  byteLength(str: string): number;
};

// Internal shape used by our Buffer ambient above.
interface BufferLike {
  length: number;
}

// Ambient process.stderr — avoids @types/node dependency.
declare const process: {
  stderr: { write: (data: string) => boolean };
};

// Minimal subset of node:http types we reference in function signatures.
interface NodeSocket {
  remoteAddress?: string;
}

interface NodeIncomingMessage {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket: NodeSocket;
}

interface NodeServerResponse {
  headersSent: boolean;
  writeHead(statusCode: number, headers?: Record<string, string | number>): void;
  end(body?: string): void;
}

interface NodeHttpServer {
  address(): { port: number; address: string; family: string } | string | null;
  listen(port: number, cb?: () => void): void;
  close(cb?: (err?: Error) => void): void;
  once(event: string, handler: (err?: Error) => void): void;
  removeListener(event: string, handler: (err?: Error) => void): void;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque alias for the node:http Server — avoids @types/node in the public API. */
// biome-ignore lint/suspicious/noExplicitAny: intentional opaque alias; @types/node not installed
export type HttpServer = any;

export interface HttpTransportConfig {
  port: number;
  bearerToken: string;
  server: McpServer;
  logger: Logger;
  healthPayload: HealthPayload;
}

/** Per-request metadata extracted by the HTTP handler. */
interface RequestContext {
  client_ip: string;
  user_agent: string;
}

// ---------------------------------------------------------------------------
// Module-level WeakMap for per-transport context (T-17 consumption hook)
// ---------------------------------------------------------------------------

/**
 * WeakMap keyed by transport instance. Allows tool handlers (in a later wave,
 * T-17) to retrieve per-request IP / UA without importing node:async_hooks.
 */
const requestContextMap = new WeakMap<StreamableHTTPServerTransport, RequestContext>();

/**
 * Returns the `{ client_ip, user_agent }` attached to a transport instance,
 * or `undefined` if not yet set (e.g. for stdio mode).
 */
export function getRequestContext(
  transport: StreamableHTTPServerTransport,
): RequestContext | undefined {
  return requestContextMap.get(transport);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time bearer token verification (US-2 AC-4).
 *
 * Pads both buffers to the same length before calling `timingSafeEqual` so
 * the comparison time does not leak whether the lengths differ. The explicit
 * `a.length === b.length` guard ensures we still return `false` on length
 * mismatch — a padded comparison alone would return `true` for same-prefix
 * tokens of different lengths.
 */
function verifyBearer(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const provided = authHeader.slice(7);
  // @ts-ignore — Buffer is a Node.js global; ambient declaration above for tsc
  const a: BufferLike = Buffer.from(provided, 'utf8');
  // @ts-ignore
  const b: BufferLike = Buffer.from(expected, 'utf8');
  const maxLen = Math.max(a.length, b.length);
  // @ts-ignore
  const bufA: BufferLike = Buffer.concat([a, Buffer.alloc(maxLen - a.length)]);
  // @ts-ignore
  const bufB: BufferLike = Buffer.concat([b, Buffer.alloc(maxLen - b.length)]);
  // @ts-ignore — timingSafeEqual imported with @ts-ignore; accepts Buffer-like args
  return a.length === b.length && timingSafeEqual(bufA, bufB);
}

/** Write a JSON response with the given status code and object body. */
function jsonResponse(res: NodeServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // @ts-ignore — Buffer.byteLength is a Node.js global
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Extract the client IP from request headers / socket. */
function extractClientIp(req: NodeIncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = (Array.isArray(xff) ? xff[0] : xff).split(',')[0];
    if (first) return first.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Returns `true` when the address is a loopback address. */
function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Emits a structured `http_request` log line (option C from the spec).
 * Tool-call-level IP/UA wiring is deferred to T-17 via AsyncLocalStorage.
 */
function logRequest(
  method: string,
  path: string,
  status: number,
  startedAt: number,
  client_ip: string,
  user_agent: string,
): void {
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'http_request',
      method,
      path,
      status,
      client_ip,
      user_agent,
      latency_ms: Date.now() - startedAt,
    })}\n`,
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Starts an HTTP server that:
 * - Serves `GET /health` (unauthenticated)
 * - Proxies `POST/GET/DELETE /mcp` to per-session `StreamableHTTPServerTransport`
 * - Rejects all other paths with 404
 * - Requires a valid `Authorization: Bearer <token>` header on all non-health routes
 *
 * Returns the bound `HttpServer` and an async `close()` that tears everything
 * down cleanly.
 */
export async function startHttpTransport(
  config: HttpTransportConfig,
): Promise<{ httpServer: HttpServer; close: () => Promise<void> }> {
  /** Active MCP sessions keyed by session ID. */
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // @ts-ignore — createServer imported with @ts-ignore above
  const httpServer: NodeHttpServer = createServer(
    async (req: NodeIncomingMessage, res: NodeServerResponse) => {
      const startedAt = Date.now();
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      // Strip query string for routing
      const path = url.split('?')[0] ?? '/';

      const remoteAddr = req.socket.remoteAddress;

      try {
        // ----------------------------------------------------------------
        // Route: /health
        // ----------------------------------------------------------------
        if (path === '/health') {
          if (method !== 'GET') {
            logRequest(
              method,
              path,
              405,
              startedAt,
              extractClientIp(req),
              String(req.headers['user-agent'] ?? ''),
            );
            jsonResponse(res, 405, { error: 'method_not_allowed' });
            return;
          }

          const { probe_ok, mode, odoo_url, odoo_db, started_at } = config.healthPayload;
          const ok = probe_ok;
          const status = probe_ok ? 200 : 503;

          let body: unknown;
          if (isLoopbackAddress(remoteAddr)) {
            // Full payload for loopback callers
            body = { ok, mode, odoo_url, odoo_db, started_at, probe_ok };
          } else {
            // Redacted payload for remote callers
            body = { ok, mode, probe_ok };
          }

          logRequest(
            method,
            path,
            status,
            startedAt,
            extractClientIp(req),
            String(req.headers['user-agent'] ?? ''),
          );
          jsonResponse(res, status, body);
          return;
        }

        // ----------------------------------------------------------------
        // Bearer auth for all non-health routes (US-2 AC-9)
        // ----------------------------------------------------------------
        const authHeader = req.headers.authorization;
        const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (!verifyBearer(authStr, config.bearerToken)) {
          logRequest(
            method,
            path,
            401,
            startedAt,
            extractClientIp(req),
            String(req.headers['user-agent'] ?? ''),
          );
          jsonResponse(res, 401, { error: 'unauthorized' });
          return;
        }

        // ----------------------------------------------------------------
        // Route: /mcp
        // ----------------------------------------------------------------
        if (path === '/mcp') {
          const client_ip = extractClientIp(req);
          const user_agent = String(req.headers['user-agent'] ?? '');
          const sessionIdHeader = req.headers['mcp-session-id'];
          const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

          let transport: StreamableHTTPServerTransport;

          if (method === 'POST' && !sessionId) {
            // New session — create a fresh transport and connect to the shared McpServer
            transport = new StreamableHTTPServerTransport({
              // @ts-ignore — randomUUID imported with @ts-ignore above
              sessionIdGenerator: () => randomUUID() as string,
            });

            // Clean up the cache entry when the transport closes
            transport.onclose = () => {
              if (transport.sessionId !== undefined) {
                sessions.delete(transport.sessionId);
              }
            };

            // Connect before handling the first request so the server is ready
            await config.server.connect(transport);

            // Cache the transport under its generated session ID
            if (transport.sessionId !== undefined) {
              sessions.set(transport.sessionId, transport);
            }
          } else if (sessionId) {
            // Existing session lookup
            const existing = sessions.get(sessionId);
            if (!existing) {
              logRequest(method, path, 404, startedAt, client_ip, user_agent);
              jsonResponse(res, 404, { error: 'session_not_found' });
              return;
            }
            transport = existing;
          } else {
            // GET/DELETE without a session ID — not valid for this protocol
            logRequest(method, path, 400, startedAt, client_ip, user_agent);
            jsonResponse(res, 400, { error: 'session_id_required' });
            return;
          }

          // Attach per-request context for downstream consumption (T-17)
          requestContextMap.set(transport, { client_ip, user_agent });

          logRequest(method, path, 200, startedAt, client_ip, user_agent);
          // @ts-ignore — req/res are node:http objects at runtime; SDK accepts them
          await transport.handleRequest(req, res);
          return;
        }

        // ----------------------------------------------------------------
        // Catch-all 404
        // ----------------------------------------------------------------
        logRequest(
          method,
          path,
          404,
          startedAt,
          extractClientIp(req),
          String(req.headers['user-agent'] ?? ''),
        );
        jsonResponse(res, 404, { error: 'not_found' });
      } catch (err) {
        // Unhandled internal error — return 500 without leaking details
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `${JSON.stringify({ event: 'http_internal_error', method, path, message })}\n`,
        );
        if (!res.headersSent) {
          jsonResponse(res, 500, { error: 'internal_server_error' });
        }
      }
    },
  );

  // Wait for the server to be listening before returning
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  /**
   * Gracefully shuts down: closes all active MCP session transports first,
   * then closes the HTTP server.
   */
  async function close(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const transport of sessions.values()) {
      closePromises.push(transport.close());
    }
    await Promise.allSettled(closePromises);
    sessions.clear();

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { httpServer, close };
}
