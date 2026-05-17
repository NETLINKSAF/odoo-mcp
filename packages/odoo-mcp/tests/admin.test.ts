/**
 * T-08: admin.ts — Admin HTTP handlers tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserStore } from '../src/user-store.js';
import type { ClientCache } from '../src/client-cache.js';
import { createAdminEndpoints } from '../src/admin.js';
import type { AdminConfig } from '../src/admin.js';

// ---------------------------------------------------------------------------
// Mock factories.
// ---------------------------------------------------------------------------

function makeUserStore(overrides: Partial<UserStore> = {}): UserStore {
  return {
    allow: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    isAllowed: vi.fn().mockReturnValue(false),
    register: vi.fn().mockResolvedValue('a'.repeat(64)),
    getCredentials: vi.fn().mockReturnValue(null),
    resolveToken: vi.fn().mockReturnValue(null),
    revokeTokensForUser: vi.fn(),
    listUsers: vi.fn().mockReturnValue([]),
    load: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UserStore;
}

function makeClientCache(overrides: Partial<ClientCache> = {}): ClientCache {
  return {
    get: vi.fn().mockReturnValue(undefined),
    set: vi.fn(),
    evict: vi.fn(),
    size: vi.fn().mockReturnValue(0),
    startSweep: vi.fn(),
    stopSweep: vi.fn(),
    ...overrides,
  } as unknown as ClientCache;
}

// ---------------------------------------------------------------------------
// HTTP mock helpers.
// ---------------------------------------------------------------------------

interface MockRes {
  _status: number | undefined;
  _headers: Record<string, string>;
  _body: string;
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
}

function makeMockRes(): MockRes {
  const res: MockRes = {
    _status: undefined,
    _headers: {},
    _body: '',
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    }),
    end: vi.fn((body?: string) => {
      res._body = body ?? '';
    }),
    setHeader: vi.fn((name: string, value: string) => {
      res._headers[name] = value;
    }),
  };
  return res;
}

interface MockReqOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  remoteAddress?: string;
}

function makeMockReq(opts: MockReqOptions = {}): IncomingMessage {
  const { method = 'GET', url = '/', headers = {}, body = '', remoteAddress = '127.0.0.1' } = opts;

  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      return req;
    },
    _emit(event: string, ...args: unknown[]) {
      for (const h of listeners[event] ?? []) h(...args);
    },
  };

  // Schedule body emission asynchronously so tests can await.
  Promise.resolve().then(() => {
    if (body) {
      req._emit('data', Buffer.from(body));
    }
    req._emit('end');
  });

  return req as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// Config factory.
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD = 'test-admin-password-secure-123';

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    adminPassword: ADMIN_PASSWORD,
    userStore: makeUserStore(),
    clientCache: makeClientCache(),
    ...overrides,
  };
}

function bearerHeader(password = ADMIN_PASSWORD): Record<string, string> {
  return { authorization: `Bearer ${password}` };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('admin endpoints', () => {
  describe('GET /admin/users', () => {
    it('returns 200 with users list when auth is valid', async () => {
      const userList = [
        { email: 'alice@example.com', status: 'allowed', registered_at: null },
        { email: 'bob@example.com', status: 'registered', registered_at: '2024-01-01T00:00:00.000Z' },
      ];
      const userStore = makeUserStore({ listUsers: vi.fn().mockReturnValue(userList) });
      const config = makeConfig({ userStore });
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({ method: 'GET', url: '/admin/users', headers: bearerHeader() });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body) as { users: unknown[] };
      expect(body.users).toEqual(userList);
    });
  });

  describe('POST /admin/users', () => {
    it('returns 201 when adding a new email', async () => {
      const userStore = makeUserStore({ isAllowed: vi.fn().mockReturnValue(false) });
      const config = makeConfig({ userStore });
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'POST',
        url: '/admin/users',
        headers: bearerHeader(),
        body: JSON.stringify({ email: 'newuser@example.com' }),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(201);
      const body = JSON.parse(res._body) as { email: string; status: string };
      expect(body.email).toBe('newuser@example.com');
      expect(body.status).toBe('allowed');
      expect(userStore.allow).toHaveBeenCalledWith('newuser@example.com');
    });

    it('returns 200 (idempotent) when email already allowed', async () => {
      const userStore = makeUserStore({ isAllowed: vi.fn().mockReturnValue(true) });
      const config = makeConfig({ userStore });
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'POST',
        url: '/admin/users',
        headers: bearerHeader(),
        body: JSON.stringify({ email: 'existing@example.com' }),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body) as { email: string; status: string };
      expect(body.email).toBe('existing@example.com');
      expect(body.status).toBe('allowed');
      // allow should NOT be called for existing users
      expect(userStore.allow).not.toHaveBeenCalled();
    });

    it('normalizes email to lowercase', async () => {
      const userStore = makeUserStore({ isAllowed: vi.fn().mockReturnValue(false) });
      const config = makeConfig({ userStore });
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'POST',
        url: '/admin/users',
        headers: bearerHeader(),
        body: JSON.stringify({ email: 'UPPER@Example.COM' }),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(201);
      const body = JSON.parse(res._body) as { email: string };
      expect(body.email).toBe('upper@example.com');
      expect(userStore.allow).toHaveBeenCalledWith('upper@example.com');
    });

    it('returns 400 for email with no @ sign', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'POST',
        url: '/admin/users',
        headers: bearerHeader(),
        body: JSON.stringify({ email: 'notanemail' }),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(400);
      const body = JSON.parse(res._body) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe('valid email required');
    });

    it('returns 400 for email with no dot after @', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'POST',
        url: '/admin/users',
        headers: bearerHeader(),
        body: JSON.stringify({ email: 'user@nodot' }),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(400);
    });
  });

  describe('DELETE /admin/users/:email', () => {
    it('returns 200 and calls revoke steps in order for existing user', async () => {
      const email = 'user@example.com';
      const userList = [{ email, status: 'allowed', registered_at: null }];

      const callOrder: string[] = [];
      const userStore = makeUserStore({
        listUsers: vi.fn().mockReturnValue(userList),
        revokeTokensForUser: vi.fn().mockImplementation(() => {
          callOrder.push('revokeTokensForUser');
        }),
        revoke: vi.fn().mockImplementation(async () => {
          callOrder.push('revoke');
        }),
      });
      const clientCache = makeClientCache({
        evict: vi.fn().mockImplementation(() => {
          callOrder.push('evict');
        }),
      });

      const config = makeConfig({ userStore, clientCache });
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'DELETE',
        url: `/admin/users/${encodeURIComponent(email)}`,
        headers: bearerHeader(),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body) as { email: string; status: string };
      expect(body.email).toBe(email);
      expect(body.status).toBe('revoked');

      // Verify revokeTokensForUser and evict called before revoke.
      expect(callOrder).toEqual(['revokeTokensForUser', 'evict', 'revoke']);
      expect(userStore.revokeTokensForUser).toHaveBeenCalledWith(email);
      expect(clientCache.evict).toHaveBeenCalledWith(email);
      expect(userStore.revoke).toHaveBeenCalledWith(email);
    });

    it('returns 404 for non-existent email', async () => {
      const userStore = makeUserStore({ listUsers: vi.fn().mockReturnValue([]) });
      const config = makeConfig({ userStore });
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'DELETE',
        url: '/admin/users/ghost@example.com',
        headers: bearerHeader(),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body) as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  describe('auth failures', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({ method: 'GET', url: '/admin/users', headers: {} });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(401);
      const body = JSON.parse(res._body) as { error: string };
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when Authorization uses wrong scheme', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'GET',
        url: '/admin/users',
        headers: { authorization: `Basic ${ADMIN_PASSWORD}` },
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(401);
      const body = JSON.parse(res._body) as { error: string };
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 for wrong bearer token (random 64-char hex)', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const wrongToken = 'a'.repeat(64); // same length as the password? No — use a real wrong token
      const req = makeMockReq({
        method: 'GET',
        url: '/admin/users',
        headers: { authorization: `Bearer ${wrongToken}` },
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(401);
      const body = JSON.parse(res._body) as { error: string };
      expect(body.error).toBe('unauthorized');
    });

    it('records failure for wrong bearer and increments adminFailures for IP', async () => {
      // We verify this indirectly: after 5 wrong requests from same IP, 6th gets 429.
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);
      const ip = '10.0.0.1';
      const headers = { authorization: 'Bearer wrong-token', 'x-forwarded-for': ip };

      // First 5 attempts should get 401.
      for (let i = 0; i < 5; i++) {
        const req = makeMockReq({ method: 'GET', url: '/admin/users', headers });
        const res = makeMockRes();
        await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);
        expect(res._status).toBe(401);
      }
    });

    it('returns 429 on 6th failure from same IP within 60s', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);
      const ip = '192.168.1.100';
      const headers = { authorization: 'Bearer wrong-token', 'x-forwarded-for': ip };

      // 5 failures first.
      for (let i = 0; i < 5; i++) {
        const req = makeMockReq({ method: 'GET', url: '/admin/users', headers });
        const res = makeMockRes();
        await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);
      }

      // 6th request → 429.
      const req6 = makeMockReq({ method: 'GET', url: '/admin/users', headers });
      const res6 = makeMockRes();
      await endpoints.handleAdminUsers(req6, res6 as unknown as ServerResponse);

      expect(res6._status).toBe(429);
      const body = JSON.parse(res6._body) as { error: string };
      expect(body.error).toBe('rate_limited');
    });

    it('does NOT increment failure count for 429 response itself', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);
      const ip = '172.16.0.1';
      const headers = { authorization: 'Bearer wrong-token', 'x-forwarded-for': ip };

      // 5 failures.
      for (let i = 0; i < 5; i++) {
        const req = makeMockReq({ method: 'GET', url: '/admin/users', headers });
        const res = makeMockRes();
        await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);
      }

      // Requests 6, 7, 8 should ALL be 429 (not eventually recovering with new failures).
      for (let i = 0; i < 3; i++) {
        const req = makeMockReq({ method: 'GET', url: '/admin/users', headers });
        const res = makeMockRes();
        await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);
        expect(res._status).toBe(429);
      }
    });

    it('returns 401 for short (10-char) Bearer token — no crash', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'GET',
        url: '/admin/users',
        headers: { authorization: 'Bearer 0123456789' },
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(401);
    });

    it('returns 401 for confused deputy — valid 64-char hex (looks like OAuth token) is not admin password', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      // A valid-looking 64-char hex access token — not the admin password.
      const fakeOauthToken = 'deadbeef'.repeat(8); // 64 chars
      const req = makeMockReq({
        method: 'GET',
        url: '/admin/users',
        headers: { authorization: `Bearer ${fakeOauthToken}` },
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(401);
      const body = JSON.parse(res._body) as { error: string };
      expect(body.error).toBe('unauthorized');
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unmatched method+path', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      const req = makeMockReq({
        method: 'PATCH',
        url: '/admin/users',
        headers: bearerHeader(),
      });
      const res = makeMockRes();

      await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);

      expect(res._status).toBe(404);
      const body = JSON.parse(res._body) as { error: string };
      expect(body.error).toBe('not_found');
    });
  });

  describe('X-Forwarded-For IP extraction', () => {
    it('uses first segment of X-Forwarded-For for rate limiting', async () => {
      const config = makeConfig();
      const endpoints = createAdminEndpoints(config);

      // Use a proxy chain header with the target IP first.
      const targetIp = '203.0.113.5';
      const headers = {
        authorization: 'Bearer wrong',
        'x-forwarded-for': `${targetIp}, 10.0.0.1, 10.0.0.2`,
      };

      // 5 failures using X-Forwarded-For.
      for (let i = 0; i < 5; i++) {
        const req = makeMockReq({ method: 'GET', url: '/admin/users', headers });
        const res = makeMockRes();
        await endpoints.handleAdminUsers(req, res as unknown as ServerResponse);
      }

      // 6th from same proxy IP → 429.
      const req6 = makeMockReq({ method: 'GET', url: '/admin/users', headers });
      const res6 = makeMockRes();
      await endpoints.handleAdminUsers(req6, res6 as unknown as ServerResponse);

      expect(res6._status).toBe(429);
    });
  });
});
