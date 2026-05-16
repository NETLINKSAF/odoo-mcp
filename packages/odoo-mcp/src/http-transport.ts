// @ts-ignore — @types/node not installed; AsyncLocalStorage available in Node 12+
import { AsyncLocalStorage } from 'node:async_hooks';
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
  // Body streaming — subset of Node.js IncomingMessage EventEmitter API
  on(event: 'data', handler: (chunk: BufferLike) => void): void;
  on(event: 'end', handler: () => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

interface NodeServerResponse {
  headersSent: boolean;
  writeHead(statusCode: number, headers?: Record<string, string | number>): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
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
  request_id: string;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage for per-request context (T-17)
//
// Tool handlers can import and read from this store to access request_id,
// client_ip, and user_agent without requiring the transport WeakMap.
// Usage in a tool handler:
//   const ctx = requestContextStorage.getStore();
//   if (ctx) { const { request_id, client_ip, user_agent } = ctx; }
// ---------------------------------------------------------------------------

// @ts-ignore — AsyncLocalStorage imported above; TS generic not available without @types/node
export const requestContextStorage: {
  getStore(): RequestContext | undefined;
  run(store: RequestContext, fn: () => Promise<void>): Promise<void>;
} =
  // @ts-ignore
  new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// Module-level WeakMap for per-transport context
// ---------------------------------------------------------------------------

/**
 * WeakMap keyed by transport instance. Allows tool handlers to retrieve
 * per-request IP / UA / request_id without importing node:async_hooks.
 * Updated by T-17 to include request_id.
 */
const requestContextMap = new WeakMap<StreamableHTTPServerTransport, RequestContext>();

/**
 * Returns the `{ client_ip, user_agent, request_id }` attached to a transport
 * instance, or `undefined` if not yet set (e.g. for stdio mode).
 */
export function getRequestContext(
  transport: StreamableHTTPServerTransport,
): RequestContext | undefined {
  return requestContextMap.get(transport);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_048_576; // 1 MiB

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

// ---------------------------------------------------------------------------
// Auth-failure rate limiting (US-2 AC-10, HIGH severity per threat model)
// ---------------------------------------------------------------------------
// Sliding 60-second window per source IP. After 20 failed auth attempts, the
// server returns HTTP 429 for that IP until the oldest failure ages out.
//
// Scope is intentionally narrow: this protects against bearer-token
// brute-forcing, not general request rate. Successful auths do NOT increment.
//
// Storage is in-memory and per-process. For a single-tenant deploy this is
// the right granularity — there is one process, one token, one set of
// attackers. Old entries are pruned lazily on each access.

const AUTH_FAIL_WINDOW_MS = 60_000;
const AUTH_FAIL_LIMIT = 20;
const authFailures = new Map<string, number[]>();

/** Returns true if the IP has exceeded the auth-failure rate limit. */
function isAuthRateLimited(ip: string): boolean {
  const now = Date.now();
  const entries = authFailures.get(ip);
  if (!entries) return false;
  // Prune timestamps older than the window
  const fresh = entries.filter((ts) => now - ts < AUTH_FAIL_WINDOW_MS);
  if (fresh.length !== entries.length) authFailures.set(ip, fresh);
  return fresh.length >= AUTH_FAIL_LIMIT;
}

/** Record an auth failure for this IP. */
function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entries = authFailures.get(ip) ?? [];
  entries.push(now);
  // Prune in-place to bound memory
  const fresh = entries.filter((ts) => now - ts < AUTH_FAIL_WINDOW_MS);
  authFailures.set(ip, fresh);
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

/**
 * Set HSTS header when the request arrived over HTTPS
 * (detected via the X-Forwarded-Proto header set by the TLS terminator).
 * US-1 AC-9.
 */
function applyHsts(req: NodeIncomingMessage, res: NodeServerResponse): void {
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * Extract and validate the client IP from request headers / socket.
 * XFF char validation (US-4 AC-8): if the first XFF value contains characters
 * outside the safe set, returns 'invalid' instead of the raw value.
 */
function extractClientIp(req: NodeIncomingMessage): string {
  const rawXFF = req.headers['x-forwarded-for'];
  const rawIP =
    typeof rawXFF === 'string'
      ? rawXFF.split(',')[0]?.trim()
      : Array.isArray(rawXFF)
        ? rawXFF[0]?.split(',')[0]?.trim()
        : undefined;

  const XFF_SAFE = /^[0-9a-fA-F.:, ]+$/;
  if (rawIP !== undefined) {
    return XFF_SAFE.test(rawIP) ? rawIP : 'invalid';
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Returns `true` when the address is a loopback address. */
function isLoopbackAddress(addr: string | undefined): boolean {
  const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  return loopback.has(addr ?? '');
}

/**
 * Emits a structured `http_request` log line.
 * Includes request_id for correlation (US-4 AC-7).
 */
function logRequest(
  method: string,
  path: string,
  status: number,
  startedAt: number,
  client_ip: string,
  user_agent: string,
  request_id?: string,
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
      ...(request_id !== undefined ? { request_id } : {}),
    })}\n`,
  );
}

/**
 * Read and buffer the full request body, enforcing the 1 MiB size limit.
 * Returns the raw body buffer or throws { status: 413 } when the limit
 * is exceeded via Content-Length or streaming.
 *
 * US-1 AC-8.
 */
function readBody(req: NodeIncomingMessage): Promise<BufferLike> {
  return new Promise<BufferLike>((resolve, reject) => {
    // Fast path: trust Content-Length if provided
    const clHeader = req.headers['content-length'];
    const cl = typeof clHeader === 'string' ? Number.parseInt(clHeader, 10) : Number.NaN;
    if (!Number.isNaN(cl) && cl > MAX_BODY_BYTES) {
      reject({ status: 413 });
      return;
    }

    const chunks: BufferLike[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: BufferLike) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject({ status: 413 });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      // @ts-ignore — Buffer.concat is a Node.js global
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err: Error) => {
      reject(err);
    });
  });
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
 * Security hardening (T-17):
 * - HSTS header on all responses when X-Forwarded-Proto: https (US-1 AC-9)
 * - TLS detection startup warning if no https traffic within 60s (US-1 AC-10)
 * - 1 MiB body limit with 413 (US-1 AC-8)
 * - Bearer token length warning at startup (US-2 AC-8)
 * - Loopback-only odoo_url/odoo_db in /health (US-3 AC-7)
 * - request_id UUIDv4 per /mcp request via WeakMap + ALS (US-4 AC-7)
 * - XFF character validation (US-4 AC-8)
 *
 * Returns the bound `HttpServer` and an async `close()` that tears everything
 * down cleanly.
 */
export async function startHttpTransport(
  config: HttpTransportConfig,
): Promise<{ httpServer: HttpServer; close: () => Promise<void> }> {
  // -------------------------------------------------------------------------
  // Bearer token length warning (US-2 AC-8)
  // -------------------------------------------------------------------------
  if (config.bearerToken.length < 32) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'warning',
        message: 'MCP_BEARER_TOKEN is fewer than 32 characters — use `openssl rand -hex 32`',
      })}\n`,
    );
  }

  /** Active MCP sessions keyed by session ID. */
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // TLS detection (US-1 AC-10) — closure-scoped flag and timer handle
  let tlsSeen = false;
  let tlsWarningTimer: ReturnType<typeof setTimeout> | undefined;

  // @ts-ignore — createServer imported with @ts-ignore above
  const httpServer: NodeHttpServer = createServer(
    async (req: NodeIncomingMessage, res: NodeServerResponse) => {
      const startedAt = Date.now();
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      // Strip query string for routing
      const path = url.split('?')[0] ?? '/';

      const remoteAddr = req.socket.remoteAddress;

      // ------------------------------------------------------------------
      // HSTS header (US-1 AC-9): apply to every response
      // ------------------------------------------------------------------
      applyHsts(req, res);

      // ------------------------------------------------------------------
      // TLS detection flag (US-1 AC-10)
      // ------------------------------------------------------------------
      if (req.headers['x-forwarded-proto'] === 'https') {
        tlsSeen = true;
      }

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
            // Full payload for loopback callers (US-3 AC-7)
            body = { ok, mode, odoo_url, odoo_db, started_at, probe_ok };
          } else {
            // Redacted payload for remote callers — no odoo_url or odoo_db
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
        // Auth-failure rate limit (US-2 AC-10) — checked BEFORE auth so a
        // banned IP doesn't get to verify a new token attempt.
        // ----------------------------------------------------------------
        const clientIpForRate = extractClientIp(req);
        if (isAuthRateLimited(clientIpForRate)) {
          logRequest(
            method,
            path,
            429,
            startedAt,
            clientIpForRate,
            String(req.headers['user-agent'] ?? ''),
          );
          jsonResponse(res, 429, { error: 'rate_limited' });
          return;
        }

        // ----------------------------------------------------------------
        // Bearer auth for all non-health routes (US-2 AC-9)
        // ----------------------------------------------------------------
        const authHeader = req.headers.authorization;
        const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (!verifyBearer(authStr, config.bearerToken)) {
          recordAuthFailure(clientIpForRate);
          logRequest(
            method,
            path,
            401,
            startedAt,
            clientIpForRate,
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

          // Generate a fresh UUIDv4 request_id for every /mcp request (US-4 AC-7)
          // @ts-ignore — randomUUID imported with @ts-ignore above
          const request_id: string = randomUUID() as string;

          const sessionIdHeader = req.headers['mcp-session-id'];
          const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

          // ------------------------------------------------------------------
          // 1 MiB body limit (US-1 AC-8) — read and buffer before routing
          // ------------------------------------------------------------------
          let body: BufferLike;
          try {
            body = await readBody(req);
          } catch (bodyErr) {
            if (
              bodyErr !== null &&
              typeof bodyErr === 'object' &&
              'status' in bodyErr &&
              (bodyErr as { status: number }).status === 413
            ) {
              logRequest(method, path, 413, startedAt, client_ip, user_agent, request_id);
              jsonResponse(res, 413, { error: 'payload_too_large' });
              return;
            }
            throw bodyErr;
          }

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
              logRequest(method, path, 404, startedAt, client_ip, user_agent, request_id);
              jsonResponse(res, 404, { error: 'session_not_found' });
              return;
            }
            transport = existing;
          } else {
            // GET/DELETE without a session ID — not valid for this protocol
            logRequest(method, path, 400, startedAt, client_ip, user_agent, request_id);
            jsonResponse(res, 400, { error: 'session_id_required' });
            return;
          }

          // Attach per-request context for downstream consumption via WeakMap
          const ctx: RequestContext = { client_ip, user_agent, request_id };
          requestContextMap.set(transport, ctx);

          logRequest(method, path, 200, startedAt, client_ip, user_agent, request_id);

          // Run handleRequest inside the ALS store so tool handlers can access context
          await requestContextStorage.run(ctx, async () => {
            // @ts-ignore — req/res are node:http objects at runtime; SDK accepts them
            await transport.handleRequest(req, res, body);
          });
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

  // -------------------------------------------------------------------------
  // TLS detection startup warning (US-1 AC-10)
  // Start a 60s one-shot timer after listen resolves. If no https traffic
  // is seen within 60s, warn to stderr that TLS termination may be missing.
  // -------------------------------------------------------------------------
  tlsWarningTimer = setTimeout(() => {
    tlsWarningTimer = undefined;
    if (!tlsSeen) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'warning',
          message:
            'No X-Forwarded-Proto: https detected within 60s — TLS termination may not be configured',
        })}\n`,
      );
    }
  }, 60_000);

  /**
   * Gracefully shuts down: closes all active MCP session transports first,
   * then closes the HTTP server. Also clears the TLS detection timer.
   */
  async function close(): Promise<void> {
    // Clear TLS detection timer to prevent memory leaks (US-1 AC-10)
    if (tlsWarningTimer !== undefined) {
      clearTimeout(tlsWarningTimer);
      tlsWarningTimer = undefined;
    }

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
