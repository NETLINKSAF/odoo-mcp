/**
 * T-08: admin.ts — Admin HTTP handlers for user management.
 */

// @ts-ignore — @types/node not installed
import { timingSafeEqual } from 'node:crypto';
// @ts-ignore — @types/node not installed
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ClientCache } from './client-cache.js';
import type { UserStore } from './user-store.js';

// ---------------------------------------------------------------------------
// Ambient declarations — avoids @types/node dependency (codebase pattern).
// ---------------------------------------------------------------------------

declare const Buffer: {
  from(value: string, encoding?: string): Buffer;
  alloc(size: number): Buffer;
};

type Buffer = {
  length: number;
  toString(encoding?: string): string;
  [index: number]: number;
};

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface AdminConfig {
  adminPassword: string;
  userStore: UserStore;
  clientCache: ClientCache;
}

export interface AdminEndpoints {
  handleAdminUsers(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Extract source IP: first segment of X-Forwarded-For, else socket.remoteAddress. */
function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw.split(',')[0];
    if (first !== undefined) {
      return first.trim();
    }
  }
  return (req.socket as { remoteAddress?: string }).remoteAddress ?? 'unknown';
}

/** Collect full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    req.on('data', (chunk: unknown) => {
      chunks.push(String(chunk));
    });
    req.on('end', () => {
      resolve(chunks.join(''));
    });
    req.on('error', (err: unknown) => {
      reject(err);
    });
  });
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createAdminEndpoints(config: AdminConfig): AdminEndpoints {
  // In-memory: IP → array of failure timestamps (ms).
  const adminFailures = new Map<string, number[]>();

  /**
   * Verify admin authorization.
   * Returns true if authorized.
   * Returns false and writes the error response if unauthorized or rate-limited.
   */
  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = getClientIp(req);
    const now = Date.now();
    const windowMs = 60_000;

    // Clean up old failures and check rate limit FIRST.
    const failures = (adminFailures.get(ip) ?? []).filter((ts) => now - ts < windowMs);
    adminFailures.set(ip, failures);

    if (failures.length >= 5) {
      // Do NOT increment failure count for the 429 itself.
      sendJson(res, 429, { error: 'rate_limited' });
      return false;
    }

    // Check Authorization header.
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      failures.push(Date.now());
      adminFailures.set(ip, failures);
      sendJson(res, 401, { error: 'unauthorized' });
      return false;
    }

    const presented = authHeader.slice(7);
    const expected = config.adminPassword;

    // Constant-time comparison: pad both to the same length (longer of the two).
    const maxLen = Math.max(presented.length, expected.length);
    // @ts-ignore — Buffer.alloc is a Node.js global
    const presentedBuf: Buffer = Buffer.alloc(maxLen);
    // @ts-ignore — Buffer.alloc is a Node.js global
    const expectedBuf: Buffer = Buffer.alloc(maxLen);

    // @ts-ignore — Buffer.from is a Node.js global
    const presentedRaw: Buffer = Buffer.from(presented, 'utf8');
    // @ts-ignore — Buffer.from is a Node.js global
    const expectedRaw: Buffer = Buffer.from(expected, 'utf8');

    for (let i = 0; i < presentedRaw.length; i++) {
      presentedBuf[i] = presentedRaw[i] as number;
    }
    for (let i = 0; i < expectedRaw.length; i++) {
      expectedBuf[i] = expectedRaw[i] as number;
    }

    // @ts-ignore — timingSafeEqual imported above
    const timingMatch = timingSafeEqual(presentedBuf, expectedBuf);
    const lengthMatch = presented.length === expected.length;

    if (!(timingMatch && lengthMatch)) {
      failures.push(Date.now());
      adminFailures.set(ip, failures);
      sendJson(res, 401, { error: 'unauthorized' });
      return false;
    }

    return true;
  }

  return {
    async handleAdminUsers(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';

      // Route: GET /admin/users
      if (method === 'GET' && url === '/admin/users') {
        if (!checkAuth(req, res)) return;
        const users = config.userStore.listUsers();
        sendJson(res, 200, { users });
        return;
      }

      // Route: POST /admin/users
      if (method === 'POST' && url === '/admin/users') {
        if (!checkAuth(req, res)) return;

        const bodyStr = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyStr);
        } catch {
          sendJson(res, 400, {
            error: 'invalid_request',
            error_description: 'valid email required',
          });
          return;
        }

        const email =
          parsed !== null && typeof parsed === 'object' && 'email' in parsed
            ? (parsed as Record<string, unknown>).email
            : undefined;

        if (typeof email !== 'string' || !/.+@.+\..+/.test(email)) {
          sendJson(res, 400, {
            error: 'invalid_request',
            error_description: 'valid email required',
          });
          return;
        }

        const normalized = email.toLowerCase();

        if (config.userStore.isAllowed(normalized)) {
          sendJson(res, 200, { email: normalized, status: 'allowed' });
        } else {
          await config.userStore.allow(normalized);
          sendJson(res, 201, { email: normalized, status: 'allowed' });
        }
        return;
      }

      // Route: DELETE /admin/users/:email
      if (method === 'DELETE' && url.startsWith('/admin/users/')) {
        if (!checkAuth(req, res)) return;

        const encodedEmail = url.slice('/admin/users/'.length);
        const email = decodeURIComponent(encodedEmail);

        const found = config.userStore.listUsers().find((u) => u.email === email);
        if (!found) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }

        // Synchronous operations BEFORE response (US-8 AC-6).
        config.userStore.revokeTokensForUser(email);
        config.clientCache.evict(email);
        await config.userStore.revoke(email);

        sendJson(res, 200, { email, status: 'revoked' });
        return;
      }

      // No route matched.
      sendJson(res, 404, { error: 'not_found' });
    },
  };
}
