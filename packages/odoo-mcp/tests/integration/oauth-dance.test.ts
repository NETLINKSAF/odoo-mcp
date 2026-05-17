/**
 * OAuth Authorization Code + PKCE integration test (T-17).
 *
 * Exercises the full OAuth dance against a real server:
 *   1. Spawn HTTP server
 *   2. Admin allow
 *   3. DCR (Dynamic Client Registration)
 *   4. PKCE generation
 *   5. GET /oauth/authorize → consent page
 *   6. POST /oauth/authorize → 302 redirect with code
 *   7. POST /oauth/token → access_token
 *   8. POST /mcp with token → valid tools/list response
 *   9. DELETE /admin/users/:email → revoke
 *  10. POST /mcp with old token → 401
 *
 * Skips the entire suite when ODOO_URL is unset (same gating pattern as odoo.test.ts).
 *
 * Prerequisites:
 *   - Odoo running and accessible via ODOO_URL
 *   - dist/bin.js built (`pnpm -r build`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawnHttpServer, type SpawnedServer } from './helpers/spawn-http-server.js';

// ── Environment gate ────────────────────────────────────────────────────────

const ODOO_URL = process.env['ODOO_URL'];
const ODOO_DB = process.env['ODOO_DB'];
const ODOO_USERNAME = process.env['ODOO_USERNAME'];
const ODOO_API_KEY = process.env['ODOO_API_KEY'];

const SKIP = !ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY;

// ── Shared state across sequential tests ───────────────────────────────────

let spawned: SpawnedServer;
let clientId: string;
let accessToken: string;

// ── Suite ───────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('OAuth dance — full Authorization Code + PKCE flow', () => {
  beforeAll(async () => {
    spawned = await spawnHttpServer({
      ODOO_URL: ODOO_URL!,
      ODOO_DB: ODOO_DB!,
      ODOO_USERNAME: ODOO_USERNAME!,
      ODOO_API_KEY: ODOO_API_KEY!,
    });
  }, 30_000);

  afterAll(async () => {
    await spawned?.cleanup();
  });

  const base = () => `http://127.0.0.1:${spawned.port}`;
  const redirectUri = 'http://127.0.0.1:9999/callback';

  // ── Step 2: Admin allow ──────────────────────────────────────────────────

  it('step 2: POST /admin/users allows the Odoo user email', async () => {
    const resp = await fetch(`${base()}/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${spawned.adminPassword}`,
      },
      body: JSON.stringify({ email: ODOO_USERNAME }),
    });
    // 201 = newly added, 200 = already exists (idempotent)
    expect(resp.status === 200 || resp.status === 201).toBe(true);
  });

  // ── Step 3: DCR ─────────────────────────────────────────────────────────

  it('step 3: POST /oauth/register returns 201 with client_id', async () => {
    const resp = await fetch(`${base()}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    expect(resp.status).toBe(201);
    const data = (await resp.json()) as { client_id: string };
    expect(typeof data.client_id).toBe('string');
    expect(data.client_id.length).toBeGreaterThan(0);
    clientId = data.client_id;
  });

  // ── Steps 4–6: PKCE + authorize ─────────────────────────────────────────

  it('steps 4–6: GET /oauth/authorize returns consent page, POST redirects with code', async () => {
    // Step 4: Generate PKCE verifier + challenge
    const verifierBytes = new Uint8Array(32);
    // @ts-ignore — crypto.getRandomValues available in Node 19+
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // @ts-ignore — crypto.subtle available in Node 19+
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(codeVerifier),
    );
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const authUrl =
      `${base()}/oauth/authorize` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code_challenge=${encodeURIComponent(codeChallenge)}` +
      `&code_challenge_method=S256` +
      `&state=teststate`;

    // Step 5: GET consent page
    const getResp = await fetch(authUrl);
    expect(getResp.status).toBe(200);
    const html = await getResp.text();
    expect(html).toContain('<form');

    // Step 6: POST credentials — capture 302 redirect
    const postResp = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `email=${encodeURIComponent(ODOO_USERNAME!)}&api_key=${encodeURIComponent(ODOO_API_KEY!)}`,
      redirect: 'manual',
    });
    expect(postResp.status).toBe(302);
    const location = postResp.headers.get('location') ?? '';
    const locationUrl = new URL(location);
    const code = locationUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    // Step 7: Token exchange
    const tokenResp = await fetch(`${base()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:
        `grant_type=authorization_code` +
        `&code=${encodeURIComponent(code!)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&code_verifier=${encodeURIComponent(codeVerifier)}`,
    });
    expect(tokenResp.status).toBe(200);
    const tokenData = (await tokenResp.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    expect(typeof tokenData.access_token).toBe('string');
    expect(tokenData.access_token.length).toBe(64); // 32 hex bytes = 64 chars
    expect(tokenData.token_type).toBe('bearer');
    expect(tokenData.scope).toBe('mcp');
    accessToken = tokenData.access_token;
  }, 30_000);

  // ── Step 8: MCP request with token ──────────────────────────────────────

  it('step 8: POST /mcp with access_token returns valid tools/list', async () => {
    const resp = await fetch(`${base()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(data.result?.tools)).toBe(true);
    expect((data.result?.tools ?? []).length).toBeGreaterThan(0);
  });

  // ── Step 9: Admin revoke ─────────────────────────────────────────────────

  it('step 9: DELETE /admin/users/:email revokes the user', async () => {
    const resp = await fetch(
      `${base()}/admin/users/${encodeURIComponent(ODOO_USERNAME!)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${spawned.adminPassword}` },
      },
    );
    expect(resp.status).toBe(200);
  });

  // ── Step 10: Old token rejected after revoke ─────────────────────────────

  it('step 10: POST /mcp with old token returns 401 after revoke', async () => {
    const resp = await fetch(`${base()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(resp.status).toBe(401);
  });
});
