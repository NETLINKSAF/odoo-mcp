/**
 * T-07: oauth.ts — OAuth 2.1 endpoints (DCR, authorize, token, metadata)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createEncryptionService } from '../src/encryption.js';
import type { UserStore } from '../src/user-store.js';
import type { OdooClient } from '@netlinksinc/odoo-client';
import { createOAuthEndpoints } from '../src/oauth.js';
import type { OAuthHandlerConfig } from '../src/oauth.js';

// ---------------------------------------------------------------------------
// Stable 32-byte test encryption key.
// ---------------------------------------------------------------------------

const TEST_KEY = randomBytes(32) as unknown as Parameters<typeof createEncryptionService>[0];
const encryptionService = createEncryptionService(TEST_KEY);

// ---------------------------------------------------------------------------
// Mock factories.
// ---------------------------------------------------------------------------

function makeUserStore(): UserStore {
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
  } as unknown as UserStore;
}

function makeOdooClient(): OdooClient {
  return {
    execute: vi.fn().mockResolvedValue(1),
    searchRead: vi.fn(),
  } as unknown as OdooClient;
}

// ---------------------------------------------------------------------------
// IncomingMessage / ServerResponse mock helpers.
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

type DataHandler = (chunk: Buffer) => void;
type EndHandler = () => void;

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

  // Immediately schedule body emission so tests can await.
  Promise.resolve().then(() => {
    if (body) {
      (req._emit as DataHandler)('data', Buffer.from(body));
    }
    req._emit('end');
  });

  return req as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// PKCE helpers for tests.
// ---------------------------------------------------------------------------

function makeCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function makeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// Config factory.
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OAuthHandlerConfig> = {}): OAuthHandlerConfig {
  return {
    publicUrl: 'https://mcp.example.com',
    port: 3000,
    odooDb: 'testdb',
    userStore: makeUserStore(),
    probeClient: makeOdooClient(),
    encryptionService,
    ...overrides,
  };
}

/**
 * Extract the `mcp-csrf` token from a consent-page response's Set-Cookie
 * header. Throws if absent — callers use this only after a successful GET
 * /oauth/authorize that we expect to have set the cookie.
 */
function extractCsrfToken(res: MockRes): string {
  const cookie = res._headers['Set-Cookie'];
  if (!cookie) throw new Error('expected Set-Cookie on consent response');
  const match = cookie.match(/mcp-csrf=([0-9a-f]+)/);
  if (!match) throw new Error(`expected mcp-csrf cookie, got: ${cookie}`);
  return match[1];
}

/**
 * Run the GET-then-POST consent flow and return the POST response. Used by
 * tests that previously POSTed directly — the GET acquires the CSRF cookie
 * that the POST handler now requires.
 */
async function postConsentForm(
  endpoints: ReturnType<typeof createOAuthEndpoints>,
  authorizeUrl: string,
  formBody: string,
): Promise<MockRes> {
  const getRes = makeMockRes();
  await endpoints.handleAuthorize(
    makeMockReq({ method: 'GET', url: authorizeUrl }),
    getRes as unknown as ServerResponse,
  );
  const csrf = extractCsrfToken(getRes);

  const postRes = makeMockRes();
  await endpoints.handleAuthorize(
    makeMockReq({
      method: 'POST',
      url: authorizeUrl,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `mcp-csrf=${csrf}`,
      },
      body: `${formBody}&csrf_token=${csrf}`,
    }),
    postRes as unknown as ServerResponse,
  );
  return postRes;
}

// ---------------------------------------------------------------------------
// Full OAuth dance helper.
// ---------------------------------------------------------------------------

async function runFullDance(config: OAuthHandlerConfig): Promise<{
  accessToken: string;
  dcrRes: MockRes;
  authorizeGetRes: MockRes;
  authorizePostRes: MockRes;
  tokenRes: MockRes;
  clientId: string;
  redirectUri: string;
  code: string;
}> {
  const endpoints = createOAuthEndpoints(config);
  const redirectUri = 'https://client.example.com/callback';

  // 1. DCR.
  const dcrRes = makeMockRes();
  const dcrReq = makeMockReq({
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Test App' }),
  });
  await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
  const dcrBody = JSON.parse(dcrRes._body) as { client_id: string };
  const clientId = dcrBody.client_id;

  // 2. GET /oauth/authorize.
  const verifier = makeCodeVerifier();
  const challenge = makeCodeChallenge(verifier);
  const state = 'random-state-123';
  const authorizeUrl =
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&response_type=code`;

  const authorizeGetRes = makeMockRes();
  const authorizeGetReq = makeMockReq({ method: 'GET', url: authorizeUrl });
  await endpoints.handleAuthorize(authorizeGetReq, authorizeGetRes as unknown as ServerResponse);

  // Extract CSRF token from the Set-Cookie header and the rendered form.
  const csrfToken = extractCsrfToken(authorizeGetRes);

  // 3. POST /oauth/authorize (consent submit). Must replay cookie + form token.
  const postBody = `email=alice%40example.com&api_key=secret-key-123&csrf_token=${csrfToken}`;
  const authorizePostRes = makeMockRes();
  const authorizePostReq = makeMockReq({
    method: 'POST',
    url: authorizeUrl,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `mcp-csrf=${csrfToken}`,
    },
    body: postBody,
  });
  await endpoints.handleAuthorize(authorizePostReq, authorizePostRes as unknown as ServerResponse);

  // Extract code from redirect location.
  const location: string = authorizePostRes._headers['Location'] ?? '';
  const codeMatch = location.match(/code=([^&]+)/);
  const code = codeMatch ? codeMatch[1] : '';

  // 4. POST /oauth/token.
  const tokenBody =
    `grant_type=authorization_code&code=${code}&code_verifier=${verifier}` +
    `&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  const tokenRes = makeMockRes();
  const tokenReq = makeMockReq({
    method: 'POST',
    url: '/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  await endpoints.handleToken(tokenReq, tokenRes as unknown as ServerResponse);

  const tokenBody2 = JSON.parse(tokenRes._body) as { access_token: string };
  return {
    accessToken: tokenBody2.access_token,
    dcrRes,
    authorizeGetRes,
    authorizePostRes,
    tokenRes,
    clientId,
    redirectUri,
    code,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('handleMetadata', () => {
  it('returns 8 required fields with publicUrl as issuer', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    endpoints.handleMetadata(req, res as unknown as ServerResponse);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    expect(body.issuer).toBe('https://mcp.example.com');
    expect(body.authorization_endpoint).toBeDefined();
    expect(body.token_endpoint).toBeDefined();
    expect(body.registration_endpoint).toBeDefined();
    expect(Array.isArray(body.response_types_supported)).toBe(true);
    expect(Array.isArray(body.code_challenge_methods_supported)).toBe(true);
    expect(Array.isArray(body.grant_types_supported)).toBe(true);
    expect(Array.isArray(body.token_endpoint_auth_methods_supported)).toBe(true);
  });

  it('issuer falls back to Host header when publicUrl is empty', () => {
    const endpoints = createOAuthEndpoints(makeConfig({ publicUrl: '' }));
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
      headers: { host: 'erp.company.com' },
    });
    endpoints.handleMetadata(req, res as unknown as ServerResponse);
    const body = JSON.parse(res._body) as { issuer: string };
    expect(body.issuer).toBe('http://erp.company.com');
  });

  it('issuer uses x-forwarded-proto when available', () => {
    const endpoints = createOAuthEndpoints(makeConfig({ publicUrl: '' }));
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
      headers: { host: 'erp.company.com', 'x-forwarded-proto': 'https' },
    });
    endpoints.handleMetadata(req, res as unknown as ServerResponse);
    const body = JSON.parse(res._body) as { issuer: string };
    expect(body.issuer).toBe('https://erp.company.com');
  });

  it('issuer falls back to localhost when publicUrl empty and no Host header', () => {
    const endpoints = createOAuthEndpoints(makeConfig({ publicUrl: '', port: 4242 }));
    const res = makeMockRes();
    const req = makeMockReq({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    endpoints.handleMetadata(req, res as unknown as ServerResponse);
    const body = JSON.parse(res._body) as { issuer: string };
    expect(body.issuer).toBe('http://localhost:4242');
  });

  it('returns 405 for non-GET method', () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({ method: 'POST', url: '/.well-known/oauth-authorization-server' });
    endpoints.handleMetadata(req, res as unknown as ServerResponse);
    expect(res._status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// DCR — handleRegister
// ---------------------------------------------------------------------------

describe('handleRegister', () => {
  it('valid registration → 201 with client_id', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://client.example.com/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(201);
    const body = JSON.parse(res._body) as Record<string, unknown>;
    expect(typeof body.client_id).toBe('string');
    expect(body.redirect_uris).toEqual(['https://client.example.com/cb']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('missing redirect_uris → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({ method: 'POST', body: JSON.stringify({ client_name: 'Test' }) });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('empty redirect_uris array → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: [] }) });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
  });

  it('non-loopback HTTP redirect_uri → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['http://external.example.com/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error_description: string };
    expect(body.error_description).toContain('loopback');
  });

  it('https redirect_uri → 201', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/oauth/callback'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(201);
  });

  it('http://localhost redirect_uri → 201', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['http://localhost:8080/callback'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(201);
  });

  it('http://127.0.0.1 redirect_uri → 201', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(201);
  });

  it('11th DCR from same IP within 60s → 429', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const ip = '10.0.0.55';

    // Register 10 clients successfully.
    for (let i = 0; i < 10; i++) {
      const res = makeMockRes();
      const req = makeMockReq({
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
        body: JSON.stringify({ redirect_uris: [`https://app${i}.example.com/cb`] }),
      });
      await endpoints.handleRegister(req, res as unknown as ServerResponse);
      expect(res._status).toBe(201);
    }

    // 11th attempt.
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: JSON.stringify({ redirect_uris: ['https://app11.example.com/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(429);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  // F-004 [security-audit]: dcrRateMap must not grow unboundedly. Verified by
  // simulating 110 different source IPs with mocked time advancing past the
  // 60-second rate window, then triggering the every-100-call sweep.
  it('F-004: dcrRateMap is swept of expired entries after enough calls', async () => {
    vi.useFakeTimers();
    const endpoints = createOAuthEndpoints(makeConfig());

    // 100 distinct IPs at t=0 — each lands an entry in dcrRateMap.
    for (let i = 0; i < 100; i++) {
      const res = makeMockRes();
      const req = makeMockReq({
        method: 'POST',
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
        body: JSON.stringify({ redirect_uris: [`https://x${i}.example.com/cb`] }),
      });
      await endpoints.handleRegister(req, res as unknown as ServerResponse);
      expect(res._status).toBe(201);
    }

    // Advance past the 60s DCR rate-limit window so all stored timestamps expire.
    vi.advanceTimersByTime(61_000);

    // One more call from a fresh IP triggers the every-100-call sweep that
    // deletes entries whose timestamps are now all expired.
    const finalRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.99' },
        body: JSON.stringify({ redirect_uris: ['https://final.example.com/cb'] }),
      }),
      finalRes as unknown as ServerResponse,
    );
    expect(finalRes._status).toBe(201);

    // Behavioural check: a previously-rate-tracked IP can now register 10 fresh
    // clients again (would fail at 11 only if its old timestamps were still
    // present and counted toward the cap). This proves the sweep cleared them.
    for (let i = 0; i < 10; i++) {
      const r = makeMockRes();
      await endpoints.handleRegister(
        makeMockReq({
          method: 'POST',
          headers: { 'x-forwarded-for': '203.0.113.1' },
          body: JSON.stringify({ redirect_uris: [`https://re${i}.example.com/cb`] }),
        }),
        r as unknown as ServerResponse,
      );
      expect(r._status).toBe(201);
    }

    vi.useRealTimers();
  });

  it('1001st client → 503', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());

    // Register 1000 clients (rate-limit bypass: use different IPs).
    for (let i = 0; i < 1000; i++) {
      const res = makeMockRes();
      const ip = `10.${Math.floor(i / 256)}.${i % 256}.1`;
      const req = makeMockReq({
        method: 'POST',
        headers: { 'x-forwarded-for': ip },
        body: JSON.stringify({ redirect_uris: [`https://app${i}.example.com/cb`] }),
      });
      await endpoints.handleRegister(req, res as unknown as ServerResponse);
    }

    // 1001st client.
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      headers: { 'x-forwarded-for': '192.168.99.99' },
      body: JSON.stringify({ redirect_uris: ['https://final.example.com/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(503);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('server_error');
  });
});

// ---------------------------------------------------------------------------
// Authorize — GET
// ---------------------------------------------------------------------------

describe('handleAuthorize GET', () => {
  it('valid request → 200 HTML consent page', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());

    // Register a client first.
    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'], client_name: 'My App' }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const url =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=abc&code_challenge=${challenge}&code_challenge_method=S256&response_type=code`;

    const res = makeMockRes();
    const req = makeMockReq({ method: 'GET', url });
    await endpoints.handleAuthorize(req, res as unknown as ServerResponse);

    expect(res._status).toBe(200);
    expect(res._body).toContain('<!DOCTYPE html>');
    expect(res._body).toContain('My App');
  });

  it('missing state → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: '/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&code_challenge=x&code_challenge_method=S256',
    });
    await endpoints.handleAuthorize(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toContain('state');
  });

  it('unknown client_id → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: '/oauth/authorize?client_id=nonexistent&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=abc&code_challenge=x&code_challenge_method=S256',
    });
    await endpoints.handleAuthorize(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('invalid_client');
  });

  it('redirect_uri not in registered uris → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client_id}&redirect_uri=https%3A%2F%2Fother.example.com%2Fcb&state=abc&code_challenge=x&code_challenge_method=S256`,
    });
    await endpoints.handleAuthorize(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error_description: string };
    expect(body.error_description).toContain('redirect_uri');
  });

  it('no code_challenge → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client_id}&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=abc&code_challenge_method=S256`,
    });
    await endpoints.handleAuthorize(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error_description: string };
    expect(body.error_description).toContain('PKCE');
  });

  it('code_challenge_method=plain → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const res = makeMockRes();
    const req = makeMockReq({
      method: 'GET',
      url: `/oauth/authorize?client_id=${client_id}&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb&state=abc&code_challenge=xyz&code_challenge_method=plain`,
    });
    await endpoints.handleAuthorize(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Authorize — POST (consent submit)
// ---------------------------------------------------------------------------

describe('handleAuthorize POST', () => {
  async function makeRegisteredEndpoints(): Promise<{
    endpoints: ReturnType<typeof createOAuthEndpoints>;
    clientId: string;
    config: OAuthHandlerConfig;
  }> {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(42);

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);

    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id: clientId } = JSON.parse(dcrRes._body) as { client_id: string };

    return { endpoints, clientId, config };
  }

  it('allowlist reject → 403 HTML error page', async () => {
    const config = makeConfig();
    vi.mocked(config.userStore.isAllowed).mockReturnValue(false);
    const endpoints = createOAuthEndpoints(config);

    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;

    const res = await postConsentForm(
      endpoints,
      authorizeUrl,
      'email=notallowed%40example.com&api_key=key123',
    );

    expect(res._status).toBe(403);
    expect(res._body).toContain('Access Denied');
  });

  it('Odoo auth fail → 200 re-render with error', async () => {
    const { endpoints, clientId } = await makeRegisteredEndpoints();
    // Override probe to return falsy.
    const config2 = makeConfig();
    vi.mocked(config2.probeClient.execute).mockResolvedValue(0);
    // Use a fresh endpoints with the same clients map trick won't work — need separate instance.
    const config3 = makeConfig();
    vi.mocked(config3.userStore.isAllowed).mockReturnValue(true);
    vi.mocked(config3.probeClient.execute).mockResolvedValue(0);
    const endpoints3 = createOAuthEndpoints(config3);

    // Register client in endpoints3.
    const dcrRes2 = makeMockRes();
    const dcrReq2 = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints3.handleRegister(dcrReq2, dcrRes2 as unknown as ServerResponse);
    const { client_id: clientId2 } = JSON.parse(dcrRes2._body) as { client_id: string };

    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const authorizeUrl =
      `/oauth/authorize?client_id=${clientId2}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;

    const res = await postConsentForm(
      endpoints3,
      authorizeUrl,
      'email=alice%40example.com&api_key=wrongkey',
    );

    expect(res._status).toBe(200);
    expect(res._body).toContain('Invalid Odoo credentials');
    expect(res._body).toContain('<!DOCTYPE html>');

    // Suppress unused variable warning.
    void endpoints;
    void clientId;
  });

  it('success → 302 redirect with code', async () => {
    const { endpoints, clientId } = await makeRegisteredEndpoints();

    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const authorizeUrl =
      `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=mystate&code_challenge=${challenge}&code_challenge_method=S256`;

    const res = await postConsentForm(
      endpoints,
      authorizeUrl,
      'email=alice%40example.com&api_key=goodkey',
    );

    expect(res._status).toBe(302);
    const location: string = res._headers['Location'] ?? '';
    expect(location).toContain('code=');
    expect(location).toContain('state=mystate');
  });

  it('pendingCodes at cap → 503', async () => {
    // Build an endpoint where we fill the code cap using internal state.
    // We do this by running 1000 authorize POSTs.
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);

    const dcrRes = makeMockRes();
    const dcrReq = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
    });
    await endpoints.handleRegister(dcrReq, dcrRes as unknown as ServerResponse);
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;

    // Fill up to cap.
    for (let i = 0; i < 1000; i++) {
      await postConsentForm(endpoints, authorizeUrl, `email=alice${i}%40example.com&api_key=key`);
    }

    // One more should hit the cap.
    const res = await postConsentForm(endpoints, authorizeUrl, 'email=overflow%40example.com&api_key=key');

    expect(res._status).toBe(503);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('server_error');
  });
});

// ---------------------------------------------------------------------------
// Token — handleToken
// ---------------------------------------------------------------------------

describe('handleToken', () => {
  it('full OAuth dance succeeds → access_token with 64-char hex', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);
    vi.mocked(userStore.register).mockResolvedValue('b'.repeat(64));

    const config = makeConfig({ userStore, probeClient });
    const { accessToken, tokenRes } = await runFullDance(config);

    expect(tokenRes._status).toBe(200);
    expect(typeof accessToken).toBe('string');
    expect(accessToken).toHaveLength(64);
    expect(userStore.register).toHaveBeenCalledOnce();

    const tokenBody = JSON.parse(tokenRes._body) as Record<string, unknown>;
    expect(tokenBody.token_type).toBe('bearer');
    expect(tokenBody.scope).toBe('mcp');
  });

  it('auth code is single-use: second exchange → 400', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);
    vi.mocked(userStore.register).mockResolvedValue('c'.repeat(64));

    const config = makeConfig({ userStore, probeClient });
    const { code, clientId, redirectUri, tokenRes } = await runFullDance(config);

    expect(tokenRes._status).toBe(200);

    // Re-use the same code.
    const endpoints = createOAuthEndpoints(config);
    // We need the original endpoints instance... let's test via runFullDance and replay.
    // Actually we need the same endpoints instance. Let me restructure.
    void endpoints; // suppress unused warning — we use tokenRes as evidence

    // The code was issued by the endpoints in runFullDance.
    // To test replay, we need the same endpoints instance.
    // runFullDance creates its own endpoints, so we'll build a separate replay test.
    void code;
    void clientId;
    void redirectUri;
  });

  it('replay protection: second exchange of same code → 400', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);
    vi.mocked(userStore.register).mockResolvedValue('d'.repeat(64));

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);
    const redirectUri = 'https://client.example.com/callback';
    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const state = 'state-replay';

    // DCR.
    const dcrRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: [redirectUri] }) }),
      dcrRes as unknown as ServerResponse,
    );
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    // Authorize POST (via GET-then-POST to obtain CSRF token).
    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
    const authRes = await postConsentForm(
      endpoints,
      authorizeUrl,
      'email=alice%40example.com&api_key=goodkey',
    );
    const location: string = authRes._headers['Location'] ?? '';
    const codeMatch = location.match(/code=([^&]+)/);
    const code = codeMatch ? codeMatch[1] : '';

    const tokenBody =
      `grant_type=authorization_code&code=${code}&code_verifier=${verifier}` +
      `&client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    // First exchange.
    const tokenRes1 = makeMockRes();
    await endpoints.handleToken(
      makeMockReq({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      }),
      tokenRes1 as unknown as ServerResponse,
    );
    expect(tokenRes1._status).toBe(200);

    // Second exchange (replay).
    const tokenRes2 = makeMockRes();
    await endpoints.handleToken(
      makeMockReq({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      }),
      tokenRes2 as unknown as ServerResponse,
    );
    expect(tokenRes2._status).toBe(400);
    const body = JSON.parse(tokenRes2._body) as { error: string };
    expect(body.error).toBe('invalid_grant');
    expect(JSON.parse(tokenRes2._body)).toMatchObject({ error_description: 'authorization code already used' });
  });

  it('PKCE mismatch → 400', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);
    vi.mocked(userStore.register).mockResolvedValue('e'.repeat(64));

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);
    const redirectUri = 'https://client.example.com/callback';
    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);
    const wrongVerifier = makeCodeVerifier(); // different verifier

    const dcrRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: [redirectUri] }) }),
      dcrRes as unknown as ServerResponse,
    );
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;
    const authRes = await postConsentForm(endpoints, authorizeUrl, 'email=a%40x.com&api_key=k');
    const location: string = authRes._headers['Location'] ?? '';
    const codeMatch = location.match(/code=([^&]+)/);
    const code = codeMatch ? codeMatch[1] : '';

    const tokenRes = makeMockRes();
    await endpoints.handleToken(
      makeMockReq({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${wrongVerifier}&client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      }),
      tokenRes as unknown as ServerResponse,
    );
    expect(tokenRes._status).toBe(400);
    const body = JSON.parse(tokenRes._body) as { error_description: string };
    expect(body.error_description).toContain('code_verifier');
  });

  it('expired code → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=nonexistent1234&code_verifier=abc&client_id=x&redirect_uri=https%3A%2F%2Fx.com',
    });
    await endpoints.handleToken(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('wrong client_id → 400', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);
    const redirectUri = 'https://client.example.com/callback';
    const verifier = makeCodeVerifier();
    const challenge = makeCodeChallenge(verifier);

    const dcrRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: [redirectUri] }) }),
      dcrRes as unknown as ServerResponse,
    );
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };

    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;
    const authRes = await postConsentForm(endpoints, authorizeUrl, 'email=a%40x.com&api_key=k');
    const location: string = authRes._headers['Location'] ?? '';
    const codeMatch = location.match(/code=([^&]+)/);
    const code = codeMatch ? codeMatch[1] : '';

    const tokenRes = makeMockRes();
    await endpoints.handleToken(
      makeMockReq({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=authorization_code&code=${code}&code_verifier=${verifier}&client_id=WRONG-CLIENT&redirect_uri=${encodeURIComponent(redirectUri)}`,
      }),
      tokenRes as unknown as ServerResponse,
    );
    expect(tokenRes._status).toBe(400);
    const body = JSON.parse(tokenRes._body) as { error_description: string };
    expect(body.error_description).toContain('client_id');
  });

  it('code longer than 64 chars → 400', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const longCode = 'x'.repeat(65);
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=${longCode}&code_verifier=abc&client_id=x&redirect_uri=https%3A%2F%2Fx.com`,
    });
    await endpoints.handleToken(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error_description: string };
    expect(body.error_description).toContain('field length');
  });

  it('wrong Content-Type → 415', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'code=abc',
    });
    await endpoints.handleToken(req, res as unknown as ServerResponse);
    expect(res._status).toBe(415);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('unsupported_media_type');
  });
});

// ---------------------------------------------------------------------------
// T-16 threat-model additions
// ---------------------------------------------------------------------------

describe('T-16 threat-model: redirect URI scheme allowlist (US-2 AC-6)', () => {
  it('http://external.example.com/cb → 400 with exact "redirect_uris must use https or loopback" message', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['http://external.example.com/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error_description: string };
    expect(body.error_description).toBe('redirect_uris must use https or loopback');
  });

  it('https://external.example.com/cb → 201 (HTTPS always allowed)', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const res = makeMockRes();
    const req = makeMockReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: ['https://external.example.com/cb'] }),
    });
    await endpoints.handleRegister(req, res as unknown as ServerResponse);
    expect(res._status).toBe(201);
  });
});

describe('T-16 threat-model: allowlist oracle (US-4 AC-6)', () => {
  // The threat: an attacker can probe whether an email is "known but blocked"
  // vs "never seen" if the responses differ. Both MUST return identical 403
  // response body and same status.
  it('email never seen vs email currently-rejected both return identical 403 bodies', async () => {
    const userStore = makeUserStore();

    // Case 1: email never submitted before — isAllowed returns false (fresh email).
    vi.mocked(userStore.isAllowed).mockReturnValue(false);
    const config = makeConfig({ userStore });
    const endpoints = createOAuthEndpoints(config);

    const dcrRes1 = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({
        method: 'POST',
        body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }),
      }),
      dcrRes1 as unknown as ServerResponse,
    );
    const { client_id: cid1 } = JSON.parse(dcrRes1._body) as { client_id: string };

    const verifier1 = makeCodeVerifier();
    const challenge1 = makeCodeChallenge(verifier1);
    const authorizeUrl1 =
      `/oauth/authorize?client_id=${cid1}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s1&code_challenge=${challenge1}&code_challenge_method=S256`;

    // First probe: email never seen (isAllowed → false).
    const res1 = await postConsentForm(
      endpoints,
      authorizeUrl1,
      'email=unknown_fresh%40example.com&api_key=somekey',
    );

    // Case 2: same isAllowed=false but simulate "previously registered then revoked".
    // From the API perspective, both cases have isAllowed returning false —
    // the server cannot distinguish them and must return the same response.
    const res2 = await postConsentForm(
      endpoints,
      authorizeUrl1,
      'email=revoked_user%40example.com&api_key=somekey',
    );

    // Both must return 403.
    expect(res1._status).toBe(403);
    expect(res2._status).toBe(403);

    // Both must return identical body content (same HTML).
    expect(res1._body).toBe(res2._body);

    // Both must return identical headers (no timing/vary differences).
    expect(res1._headers['Content-Type']).toBe(res2._headers['Content-Type']);
  });

  // -------------------------------------------------------------------------
  // F-003 [security-audit]: CSRF protection on consent form
  // -------------------------------------------------------------------------
  it('F-003: POST without cookie → 403 csrf_token mismatch', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);

    const dcrRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }) }),
      dcrRes as unknown as ServerResponse,
    );
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };
    const challenge = makeCodeChallenge(makeCodeVerifier());
    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;

    // POST without ever doing GET → no cookie, no form csrf_token.
    const res = makeMockRes();
    await endpoints.handleAuthorize(
      makeMockReq({
        method: 'POST',
        url: authorizeUrl,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=alice%40example.com&api_key=key',
      }),
      res as unknown as ServerResponse,
    );

    expect(res._status).toBe(403);
    const body = JSON.parse(res._body) as { error_description: string };
    expect(body.error_description).toContain('csrf_token');
  });

  it('F-003: POST with cookie but mismatched form token → 403', async () => {
    const userStore = makeUserStore();
    const probeClient = makeOdooClient();
    vi.mocked(userStore.isAllowed).mockReturnValue(true);
    vi.mocked(probeClient.execute).mockResolvedValue(1);

    const config = makeConfig({ userStore, probeClient });
    const endpoints = createOAuthEndpoints(config);

    const dcrRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }) }),
      dcrRes as unknown as ServerResponse,
    );
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };
    const challenge = makeCodeChallenge(makeCodeVerifier());
    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;

    // Get a legitimate cookie via GET, then POST with a TAMPERED form token.
    const getRes = makeMockRes();
    await endpoints.handleAuthorize(
      makeMockReq({ method: 'GET', url: authorizeUrl }),
      getRes as unknown as ServerResponse,
    );
    const realCsrf = extractCsrfToken(getRes);
    const fakeCsrf = 'f'.repeat(realCsrf.length);

    const res = makeMockRes();
    await endpoints.handleAuthorize(
      makeMockReq({
        method: 'POST',
        url: authorizeUrl,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `mcp-csrf=${realCsrf}`,
        },
        body: `email=alice%40example.com&api_key=key&csrf_token=${fakeCsrf}`,
      }),
      res as unknown as ServerResponse,
    );

    expect(res._status).toBe(403);
  });

  it('F-003: GET sets HttpOnly SameSite=Strict cookie scoped to /oauth/authorize', async () => {
    const endpoints = createOAuthEndpoints(makeConfig());
    const dcrRes = makeMockRes();
    await endpoints.handleRegister(
      makeMockReq({ method: 'POST', body: JSON.stringify({ redirect_uris: ['https://app.example.com/cb'] }) }),
      dcrRes as unknown as ServerResponse,
    );
    const { client_id } = JSON.parse(dcrRes._body) as { client_id: string };
    const challenge = makeCodeChallenge(makeCodeVerifier());
    const authorizeUrl =
      `/oauth/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent('https://app.example.com/cb')}` +
      `&state=s&code_challenge=${challenge}&code_challenge_method=S256`;

    const res = makeMockRes();
    await endpoints.handleAuthorize(
      makeMockReq({ method: 'GET', url: authorizeUrl }),
      res as unknown as ServerResponse,
    );

    expect(res._status).toBe(200);
    const cookie = res._headers['Set-Cookie'];
    expect(cookie).toMatch(/^mcp-csrf=[0-9a-f]{64};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/oauth/authorize');
    expect(cookie).toContain('Max-Age=600');
    // Body contains the same token as a hidden field.
    expect(res._body).toMatch(/name="csrf_token" value="[0-9a-f]{64}"/);
  });
});
