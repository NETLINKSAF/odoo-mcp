// @ts-ignore — @types/node not installed; AsyncLocalStorage available in Node 12+
import { AsyncLocalStorage } from 'node:async_hooks';
// @ts-ignore
import { randomUUID } from 'node:crypto';
// @ts-ignore — @types/node not installed; resolves correctly at Node.js runtime
import { createServer } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { AdminEndpoints } from './admin.js';
import type { ClientCache } from './client-cache.js';
import type { Logger } from './logger.js';
import type { OAuthEndpoints } from './oauth.js';
import type { HealthPayload } from './types.js';
import type { RequestContext } from './types.js';
import type { UserStore } from './user-store.js';

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
  /**
   * Factory: builds a fresh McpServer per new HTTP session. The MCP SDK
   * rejects a second `server.connect(transport)` call on the same server
   * instance with "Already connected to a transport", so multi-session
   * HTTP must NOT share one server across sessions.
   */
  createServerInstance: () => McpServer;
  logger: Logger;
  healthPayload: HealthPayload;
  /**
   * When `true`, the /health redaction decision trusts the first entry of
   * `X-Forwarded-For` to determine whether the real client is loopback. Use
   * `true` for deployments behind a known reverse proxy on the same host
   * (Caddy, nginx, fly.io edge). Default `false` preserves the original
   * unspoofable behavior for direct deployments.
   */
  trustProxy?: boolean;
  oauthEndpoints: OAuthEndpoints;
  adminEndpoints: AdminEndpoints;
  userStore: UserStore;
  clientCache: ClientCache;
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

const MAX_BODY_BYTES = 65_536; // 64 KiB body limit (US-1 AC-8 / US-11 AC-8 [threat-model])

/** Maximum number of concurrent MCP sessions (F-003). */
export const _MAX_SESSIONS = 100;

/** Hard cap on the authFailures Map size (F-004). */
export const _AUTH_FAILURE_MAP_CAP = 10_000;

/** Fraction of oldest entries to evict when the authFailures cap is hit (F-004). */
const AUTH_FAILURE_EVICT_FRACTION = 0.25;

/** How often the authFailures sweep runs (ms). */
const AUTH_FAILURE_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Entries whose newest failure is older than this are pruned by the sweep. */
const AUTH_FAILURE_SWEEP_MAX_AGE_MS = 60_000; // 60 seconds

/** How often the session idle-timeout sweep runs (ms). */
const SESSION_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Sessions idle longer than this are closed (ms). */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000; // 30 minutes

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

/** Record an auth failure for this IP. Enforces the hard cap (F-004). */
function recordAuthFailure(ip: string): void {
  const now = Date.now();

  // Hard cap: if the Map is at or above the cap, evict the oldest 25% before
  // adding a new entry. Uses a simple one-pass collect-and-delete — the Map is
  // small relative to memory and is rarely accessed at scale.
  if (authFailures.size >= _AUTH_FAILURE_MAP_CAP && !authFailures.has(ip)) {
    const evictCount = Math.ceil(_AUTH_FAILURE_MAP_CAP * AUTH_FAILURE_EVICT_FRACTION);
    let evicted = 0;
    for (const key of authFailures.keys()) {
      if (evicted >= evictCount) break;
      authFailures.delete(key);
      evicted++;
    }
  }

  const entries = authFailures.get(ip) ?? [];
  entries.push(now);
  // Prune in-place to bound memory
  const fresh = entries.filter((ts) => now - ts < AUTH_FAIL_WINDOW_MS);
  authFailures.set(ip, fresh);
}

/**
 * Periodic sweep: remove authFailures entries whose newest timestamp is older
 * than AUTH_FAILURE_SWEEP_MAX_AGE_MS. Runs every AUTH_FAILURE_SWEEP_INTERVAL_MS.
 * Returned handle must be cleared in closeTransport() (F-004).
 */
function startAuthFailureSweep(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const cutoff = Date.now() - AUTH_FAILURE_SWEEP_MAX_AGE_MS;
    for (const [ip, timestamps] of authFailures) {
      const newest = timestamps.length > 0 ? Math.max(...timestamps) : 0;
      if (newest < cutoff) {
        authFailures.delete(ip);
      }
    }
  }, AUTH_FAILURE_SWEEP_INTERVAL_MS);
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
 * Build the RFC 6750 + RFC 9728 WWW-Authenticate header value that tells
 * unauthenticated clients where to find the resource metadata document.
 * Required by the MCP authorization spec — Cowork/Claude Desktop will
 * stop after a bare `401` and refuse to proceed.
 */
function buildWwwAuthenticate(req: NodeIncomingMessage): string {
  // @ts-ignore — req.headers available at runtime
  const protoHeader: string | string[] | undefined = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader) ?? 'http';
  // @ts-ignore — req.headers available at runtime
  const hostHeader: string | string[] | undefined = req.headers.host;
  const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ?? 'localhost';
  const metadataUrl = `${proto}://${host}/.well-known/oauth-protected-resource`;
  return `Bearer realm="MCP", resource_metadata="${metadataUrl}"`;
}

/** Send 401 with WWW-Authenticate pointing at the resource-metadata document. */
function unauthorizedResponse(req: NodeIncomingMessage, res: NodeServerResponse): void {
  const payload = JSON.stringify({ error: 'unauthorized' });
  res.writeHead(401, {
    'Content-Type': 'application/json',
    // @ts-ignore — Buffer.byteLength is a Node.js global
    'Content-Length': Buffer.byteLength(payload),
    'WWW-Authenticate': buildWwwAuthenticate(req),
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
 * Determines whether the /health request originated from a true local caller
 * and should therefore receive the full payload (including odoo_url and
 * odoo_db).
 *
 * Decision matrix:
 * - Socket remote address is non-loopback                              → false (external)
 * - Socket is loopback AND no X-Forwarded-For header                   → true  (genuine local call)
 * - Socket is loopback AND X-Forwarded-For present AND !trustProxy     → false (don't trust spoofable XFF; safer to redact)
 * - Socket is loopback AND X-Forwarded-For present AND  trustProxy     → use first-hop XFF for the decision
 *
 * This matters when a reverse proxy (Caddy, nginx, fly.io) is on the same
 * host: every request arrives at Node from 127.0.0.1, so the original
 * unspoofable socket check would always full-payload external callers.
 */
function isLocalHealthCaller(
  socketAddr: string | undefined,
  xffHeader: string | string[] | undefined,
  trustProxy: boolean,
): boolean {
  if (!isLoopbackAddress(socketAddr)) return false;

  const xff =
    typeof xffHeader === 'string' ? xffHeader : Array.isArray(xffHeader) ? xffHeader[0] : undefined;

  if (xff === undefined) return true;
  if (!trustProxy) return false;

  const firstHop = xff.split(',')[0]?.trim();
  return isLoopbackAddress(firstHop);
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
 * Read and buffer the full request body, enforcing the 64 KiB size limit.
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
 * - Dispatches OAuth discovery/flow routes to oauthEndpoints (no auth)
 * - Dispatches admin routes to adminEndpoints (admin-password auth inside)
 * - Proxies `POST/GET/DELETE /mcp` to per-session `StreamableHTTPServerTransport`
 * - Rejects all other paths with 404
 * - Requires a valid OAuth access token on /mcp routes
 *
 * Security hardening (T-17, T-11):
 * - HSTS header on all responses when X-Forwarded-Proto: https (US-1 AC-9)
 * - TLS detection startup warning if no https traffic within 60s (US-1 AC-10)
 * - 64 KiB body limit with 413 (US-1 AC-8 / US-11 AC-8 [threat-model])
 * - OAuth token resolution via UserStore (US-11)
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
  /** Active MCP sessions keyed by session ID. */
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  /** Last-activity timestamps keyed by session ID (F-003 idle timeout). */
  const sessionLastActivity = new Map<string, number>();

  // Session idle-timeout sweep (F-003): close sessions idle > SESSION_IDLE_TIMEOUT_MS
  const sessionSweepHandle = setInterval(() => {
    const now = Date.now();
    for (const [sid, lastAt] of sessionLastActivity) {
      if (now - lastAt > SESSION_IDLE_TIMEOUT_MS) {
        const transport = sessions.get(sid);
        if (transport) {
          transport.close().catch(() => undefined);
          sessions.delete(sid);
        }
        sessionLastActivity.delete(sid);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);

  // Auth-failure periodic sweep (F-004)
  const authFailureSweepHandle = startAuthFailureSweep();

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
          if (
            isLocalHealthCaller(
              remoteAddr,
              req.headers['x-forwarded-for'],
              config.trustProxy === true,
            )
          ) {
            // Full payload for genuine local callers (US-3 AC-7)
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
        // Route: /.well-known/oauth-authorization-server — no auth required
        // ----------------------------------------------------------------
        if (path === '/.well-known/oauth-authorization-server') {
          config.oauthEndpoints.handleMetadata(req, res);
          logRequest(
            method,
            path,
            200,
            startedAt,
            extractClientIp(req),
            String(req.headers['user-agent'] ?? ''),
          );
          return;
        }

        // ----------------------------------------------------------------
        // Route: /.well-known/oauth-protected-resource[/mcp] — RFC 9728.
        // Required by the MCP authorization spec; clients fetch this to
        // discover which authorization server issues tokens for /mcp.
        // ----------------------------------------------------------------
        if (
          path === '/.well-known/oauth-protected-resource' ||
          path === '/.well-known/oauth-protected-resource/mcp'
        ) {
          config.oauthEndpoints.handleResourceMetadata(req, res);
          logRequest(
            method,
            path,
            200,
            startedAt,
            extractClientIp(req),
            String(req.headers['user-agent'] ?? ''),
          );
          return;
        }

        // ----------------------------------------------------------------
        // Route: /oauth/* — oauth endpoints handle their own rate limiting and validation
        // ----------------------------------------------------------------
        if (path === '/oauth/register') {
          await config.oauthEndpoints.handleRegister(req, res);
          return;
        }
        if (path === '/oauth/authorize') {
          await config.oauthEndpoints.handleAuthorize(req, res);
          return;
        }
        if (path === '/oauth/token') {
          await config.oauthEndpoints.handleToken(req, res);
          return;
        }

        // ----------------------------------------------------------------
        // Route: /admin/* — admin endpoints handle their own auth and rate limiting
        // ----------------------------------------------------------------
        if (path.startsWith('/admin/')) {
          await config.adminEndpoints.handleAdminUsers(req, res);
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
        // OAuth token auth for all non-health, non-oauth, non-admin routes (US-11)
        // ----------------------------------------------------------------
        const authHeader = req.headers.authorization;
        const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        const rawToken = authStr?.startsWith('Bearer ') ? authStr.slice(7) : undefined;
        if (!rawToken) {
          recordAuthFailure(clientIpForRate);
          logRequest(
            method,
            path,
            401,
            startedAt,
            clientIpForRate,
            String(req.headers['user-agent'] ?? ''),
          );
          unauthorizedResponse(req, res);
          return;
        }
        const tokenResult = config.userStore.resolveToken(rawToken);
        if (!tokenResult || !config.userStore.isAllowed(tokenResult.email)) {
          recordAuthFailure(clientIpForRate);
          logRequest(
            method,
            path,
            401,
            startedAt,
            clientIpForRate,
            String(req.headers['user-agent'] ?? ''),
          );
          unauthorizedResponse(req, res);
          return;
        }
        const { email } = tokenResult;

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
          // 64 KiB body limit (US-1 AC-8 / US-11 AC-8 [threat-model]) — read,
          // cap, and PARSE before routing. The MCP SDK's handleRequest expects
          // a parsed JSON body in its third argument (see
          // StreamableHTTPServerTransport.handleRequest signature
          // `parsedBody?: unknown`). Passing a raw Buffer makes the SDK skip
          // the initialize handshake silently — sessionId never gets set,
          // Mcp-Session-Id header is never sent, and the client falls back
          // to no-session GETs that 400 here.
          // ------------------------------------------------------------------
          let body: unknown;
          try {
            const raw = await readBody(req);
            // BufferLike.toString() returns the buffer as utf-8 text at runtime.
            // @ts-ignore — ambient BufferLike doesn't model the encoding arg
            const text = String(raw.toString('utf8') as string);
            // GET/DELETE have no body; only parse for methods that carry one.
            if (method === 'POST' && text.length > 0) {
              try {
                body = JSON.parse(text);
              } catch {
                logRequest(method, path, 400, startedAt, client_ip, user_agent, request_id);
                jsonResponse(res, 400, { error: 'invalid_json' });
                return;
              }
            } else {
              body = undefined;
            }
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
            // Session cap check (F-003)
            if (sessions.size >= _MAX_SESSIONS) {
              logRequest(method, path, 503, startedAt, client_ip, user_agent, request_id);
              jsonResponse(res, 503, { error: 'too_many_sessions' });
              return;
            }

            // New session — create a fresh transport AND a fresh McpServer.
            // The SDK rejects a second `server.connect()` call on the same
            // instance, so each session needs its own server.
            //
            // Critical: `transport.sessionId` is NOT set at construction —
            // the SDK assigns it inside handleRequest() when it processes
            // the `initialize` request. Use the `onsessioninitialized`
            // callback (called synchronously when the SDK generates the
            // id) to populate the sessions Map. If you read sessionId
            // before handleRequest, you get `undefined` and the Map stays
            // empty, so the next request from the client can't find the
            // session and the client falls back to no-session GETs that
            // 400 here.
            transport = new StreamableHTTPServerTransport({
              // @ts-ignore — randomUUID imported with @ts-ignore above
              sessionIdGenerator: () => randomUUID() as string,
              onsessioninitialized: (id: string) => {
                // biome-ignore lint/style/noNonNullAssertion: transport is defined in this branch
                sessions.set(id, transport!);
                sessionLastActivity.set(id, Date.now());
              },
            });
            const sessionServer = config.createServerInstance();

            // Clean up the cache entry when the transport closes
            transport.onclose = () => {
              if (transport.sessionId !== undefined) {
                sessions.delete(transport.sessionId);
                sessionLastActivity.delete(transport.sessionId);
              }
            };

            // Connect before handling the first request so the server is ready
            await sessionServer.connect(transport);
          } else if (sessionId) {
            // Existing session lookup
            const existing = sessions.get(sessionId);
            if (!existing) {
              logRequest(method, path, 404, startedAt, client_ip, user_agent, request_id);
              jsonResponse(res, 404, { error: 'session_not_found' });
              return;
            }
            transport = existing;
            // Update last activity for idle-timeout tracking (F-003)
            sessionLastActivity.set(sessionId, Date.now());
          } else {
            // GET/DELETE without a session ID — not valid for this protocol
            logRequest(method, path, 400, startedAt, client_ip, user_agent, request_id);
            jsonResponse(res, 400, { error: 'session_id_required' });
            return;
          }

          // Attach per-request context for downstream consumption via WeakMap
          const ctx: RequestContext = {
            client_ip,
            user_agent,
            request_id,
            user_id: email,
            odoo_credentials_handle: email,
          };
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
   * then closes the HTTP server. Also clears the TLS detection timer and sweep
   * intervals so tests don't hang (F-003, F-004).
   */
  async function close(): Promise<void> {
    // Clear TLS detection timer to prevent memory leaks (US-1 AC-10)
    if (tlsWarningTimer !== undefined) {
      clearTimeout(tlsWarningTimer);
      tlsWarningTimer = undefined;
    }

    // Clear sweep intervals (F-003, F-004)
    clearInterval(sessionSweepHandle);
    clearInterval(authFailureSweepHandle);

    const closePromises: Promise<void>[] = [];
    for (const transport of sessions.values()) {
      closePromises.push(transport.close());
    }
    await Promise.allSettled(closePromises);
    sessions.clear();
    sessionLastActivity.clear();

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return { httpServer, close };
}
