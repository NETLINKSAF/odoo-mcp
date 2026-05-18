// @ts-ignore — @types/node not installed
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// @ts-ignore — @types/node not installed
import type { IncomingMessage, ServerResponse } from 'node:http';
// @ts-ignore — @types/node not installed
import { parse as parseQs } from 'node:querystring';

import { type OdooClient, jsonRpc } from '@netlinksinc/odoo-client';

import { renderConsentPage, renderErrorPage } from './consent-page.js';
import type { EncryptionService } from './encryption.js';
import type { UserStore } from './user-store.js';

// ---------------------------------------------------------------------------
// Ambient declarations — avoids @types/node dependency (codebase pattern).
// ---------------------------------------------------------------------------

declare const Buffer: {
  from(value: string, encoding?: string): BufferLike;
  alloc(size: number): BufferLike;
};

type BufferLike = {
  length: number;
  toString(encoding?: string): string;
  [index: number]: number;
};

declare const process: {
  stderr: { write: (data: string) => boolean };
};

// ---------------------------------------------------------------------------
// Public interfaces.
// ---------------------------------------------------------------------------

export interface OAuthHandlerConfig {
  publicUrl: string;
  port: number;
  /** Base URL of the Odoo instance (no trailing slash). Used to verify end-user creds via `common.authenticate`. */
  odooUrl: string;
  odooDb: string;
  userStore: UserStore;
  probeClient: OdooClient;
  encryptionService: EncryptionService;
}

export interface OAuthEndpoints {
  handleMetadata(req: IncomingMessage, res: ServerResponse): void;
  /**
   * RFC 9728 Protected Resource Metadata — served at
   * /.well-known/oauth-protected-resource[/<path>]. Required by the MCP
   * authorization spec so clients can discover which authorization server
   * issues tokens for this resource.
   */
  handleResourceMetadata(req: IncomingMessage, res: ServerResponse): void;
  handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleToken(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types.
// ---------------------------------------------------------------------------

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name: string;
  created_at: number;
}

interface PendingAuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  encrypted_api_key: string;
  email: string;
  expires_at: number;
  used: boolean;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const MAX_CLIENTS = 1000;
const MAX_PENDING_CODES = 1000;
const DCR_RATE_WINDOW_MS = 60_000;
const DCR_RATE_MAX = 10;
const BODY_READ_CAP = 64 * 1024; // 64 KiB

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** base64url-encode a Buffer-like value. */
function toBase64url(buf: BufferLike): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Read request body up to `cap` bytes; resolves with the string. */
function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: BufferLike[] = [];
    let total = 0;
    // @ts-ignore — req.on is available on IncomingMessage
    req.on('data', (chunk: BufferLike) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    // @ts-ignore — req.on is available on IncomingMessage
    req.on('end', () => {
      resolve(chunks.map((c) => c.toString()).join(''));
    });
    // @ts-ignore — req.on is available on IncomingMessage
    req.on('error', (err: Error) => reject(err));
  });
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  // @ts-ignore — res methods available at runtime
  res.writeHead(status, { 'Content-Type': 'application/json' });
  // @ts-ignore — res.end available at runtime
  res.end(payload);
}

/** Send an HTML response. */
function sendHtml(res: ServerResponse, status: number, html: string): void {
  // @ts-ignore — res methods available at runtime
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  // @ts-ignore — res.end available at runtime
  res.end(html);
}

/** Send the consent page with a freshly-issued CSRF cookie + form token. */
function sendConsentHtml(
  res: ServerResponse,
  status: number,
  html: string,
  csrfToken: string,
): void {
  const cookie = `mcp-csrf=${csrfToken}; HttpOnly; SameSite=Strict; Path=/oauth/authorize; Max-Age=600`;
  // @ts-ignore — res methods available at runtime
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie });
  // @ts-ignore — res.end available at runtime
  res.end(html);
}

/** Extract `mcp-csrf` from a Cookie header, or undefined if absent/malformed. */
function readCsrfCookie(req: IncomingMessage): string | undefined {
  // @ts-ignore — req.headers available at runtime
  const raw: string | string[] | undefined = req.headers?.cookie;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  // Cookies are `; `-separated. Token is hex so no escaping needed.
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'mcp-csrf') return rest.join('=');
  }
  return undefined;
}

/** Constant-time comparison of two CSRF token strings (returns false on length mismatch). */
function csrfMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  // @ts-ignore — Buffer + timingSafeEqual at runtime
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Compute base64url(SHA256(input)). */
function sha256Base64url(input: string): string {
  // @ts-ignore — createHash imported above
  const hash: BufferLike = createHash('sha256').update(input).digest();
  return toBase64url(hash);
}

/** Get source IP from request. */
function getSourceIp(req: IncomingMessage): string {
  // @ts-ignore — req.headers available at runtime
  const xff: string | undefined = req.headers?.['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  // @ts-ignore — req.socket available at runtime
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Derive issuer from request context and config. */
function deriveIssuer(req: IncomingMessage, config: OAuthHandlerConfig): string {
  if (config.publicUrl !== '') return config.publicUrl;
  // @ts-ignore — req.headers available at runtime
  const host: string | undefined = req.headers?.host;
  if (host) {
    // @ts-ignore — req.headers available at runtime
    const proto: string = req.headers?.['x-forwarded-proto'] ?? 'http';
    return `${proto}://${host}`;
  }
  return `http://localhost:${config.port}`;
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createOAuthEndpoints(config: OAuthHandlerConfig): OAuthEndpoints {
  const clients = new Map<string, RegisteredClient>();
  const pendingCodes = new Map<string, PendingAuthCode>();
  const dcrRateMap = new Map<string, number[]>();
  // Counter triggers a full sweep of expired dcrRateMap entries every Nth
  // register call. Prevents unbounded key growth under IP-rotation spam.
  let dcrSweepCounter = 0;
  const DCR_SWEEP_EVERY = 100;

  // -------------------------------------------------------------------------
  // handleMetadata — GET /.well-known/oauth-authorization-server
  // -------------------------------------------------------------------------

  function handleMetadata(req: IncomingMessage, res: ServerResponse): void {
    // @ts-ignore — req.method available at runtime
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const issuer = deriveIssuer(req, config);

    sendJson(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  }

  // -------------------------------------------------------------------------
  // handleResourceMetadata — GET /.well-known/oauth-protected-resource[/<path>]
  // RFC 9728. Tells MCP clients which authorization server issues tokens for
  // this MCP resource. Required by the latest MCP authorization spec.
  // -------------------------------------------------------------------------

  function handleResourceMetadata(req: IncomingMessage, res: ServerResponse): void {
    // @ts-ignore — req.method available at runtime
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    const issuer = deriveIssuer(req, config);
    sendJson(res, 200, {
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${issuer}/`,
    });
  }

  // -------------------------------------------------------------------------
  // handleRegister — POST /oauth/register
  // -------------------------------------------------------------------------

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // @ts-ignore — req.method available at runtime
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    // DCR rate limiting.
    const ip = getSourceIp(req);
    const now = Date.now();
    const timestamps = (dcrRateMap.get(ip) ?? []).filter((t) => now - t < DCR_RATE_WINDOW_MS);
    if (timestamps.length >= DCR_RATE_MAX) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }
    timestamps.push(now);
    dcrRateMap.set(ip, timestamps);

    // Opportunistic full sweep every Nth call — clears entries whose
    // timestamps have all expired (otherwise the Map grows unboundedly under
    // sustained IP-rotation spam).
    dcrSweepCounter++;
    if (dcrSweepCounter >= DCR_SWEEP_EVERY) {
      dcrSweepCounter = 0;
      for (const [k, v] of dcrRateMap.entries()) {
        const fresh = v.filter((t) => now - t < DCR_RATE_WINDOW_MS);
        if (fresh.length === 0) dcrRateMap.delete(k);
        else if (fresh.length !== v.length) dcrRateMap.set(k, fresh);
      }
    }

    // Read and parse body.
    let bodyText: string;
    try {
      bodyText = await readBody(req, BODY_READ_CAP);
    } catch {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'could not read request body',
      });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'request body must be JSON',
      });
      return;
    }

    // Validate redirect_uris.
    const redirect_uris = body.redirect_uris;
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      sendJson(res, 400, {
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
      });
      return;
    }

    for (const uri of redirect_uris) {
      if (
        typeof uri !== 'string' ||
        (!uri.startsWith('https://') &&
          !uri.startsWith('http://127.0.0.1') &&
          !uri.startsWith('http://localhost'))
      ) {
        sendJson(res, 400, {
          error: 'invalid_client_metadata',
          error_description: 'redirect_uris must use https or loopback',
        });
        return;
      }
    }

    // Capacity check.
    if (clients.size >= MAX_CLIENTS) {
      sendJson(res, 503, {
        error: 'server_error',
        error_description: 'registration limit reached',
      });
      return;
    }

    // Register.
    // @ts-ignore — randomUUID available in Node 14.17+
    const { randomUUID } = await import('node:crypto');
    // @ts-ignore — randomUUID is typed as () => string
    const client_id: string = randomUUID();
    const client_name = typeof body.client_name === 'string' ? body.client_name : '';
    const client: RegisteredClient = {
      client_id,
      redirect_uris: redirect_uris as string[],
      client_name,
      created_at: Date.now(),
    };
    clients.set(client_id, client);

    sendJson(res, 201, {
      client_id,
      redirect_uris,
      client_name,
      token_endpoint_auth_method: 'none',
    });
  }

  // -------------------------------------------------------------------------
  // handleAuthorize — GET (consent page) / POST (submit)
  // -------------------------------------------------------------------------

  async function handleAuthorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // @ts-ignore — req.method and req.url available at runtime
    const method: string = req.method ?? 'GET';
    // @ts-ignore — req.url available at runtime
    const rawUrl: string = req.url ?? '/';

    // Parse query string — works for both GET and POST (OAuth params come from query).
    const questionIdx = rawUrl.indexOf('?');
    const queryString = questionIdx >= 0 ? rawUrl.slice(questionIdx + 1) : '';
    // @ts-ignore — parseQs imported above
    const query = parseQs(queryString) as Record<string, string | string[] | undefined>;

    const getParam = (key: string): string | undefined => {
      const v = query[key];
      return Array.isArray(v) ? v[0] : v;
    };

    const state = getParam('state');
    const client_id = getParam('client_id');
    const redirect_uri = getParam('redirect_uri');
    const code_challenge = getParam('code_challenge');
    const code_challenge_method = getParam('code_challenge_method');

    // Validate state.
    if (!state) {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'state parameter is required',
      });
      return;
    }

    // Validate client.
    const client = client_id ? clients.get(client_id) : undefined;
    if (!client) {
      sendJson(res, 400, { error: 'invalid_client', error_description: 'unknown client_id' });
      return;
    }

    // Validate redirect_uri.
    if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'redirect_uri mismatch',
      });
      return;
    }

    // Validate PKCE.
    if (!code_challenge || code_challenge_method !== 'S256') {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'PKCE with S256 is required',
      });
      return;
    }

    if (method === 'GET') {
      // Render consent page with a fresh CSRF token bound to a SameSite=Strict cookie.
      // @ts-ignore — randomBytes imported above
      const csrfToken: string = randomBytes(32).toString('hex');
      const html = renderConsentPage({
        client_name: client.client_name,
        formAction: rawUrl,
        csrf_token: csrfToken,
      });
      sendConsentHtml(res, 200, html, csrfToken);
      return;
    }

    // POST: process form submission.
    let bodyText: string;
    try {
      bodyText = await readBody(req, BODY_READ_CAP);
    } catch {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'could not read request body',
      });
      return;
    }

    // @ts-ignore — parseQs imported above
    const formData = parseQs(bodyText) as Record<string, string | string[] | undefined>;
    const getField = (key: string): string => {
      const v = formData[key];
      return (Array.isArray(v) ? v[0] : v) ?? '';
    };

    // CSRF protection: form `csrf_token` must equal the `mcp-csrf` cookie set by
    // the GET handler. SameSite=Strict on the cookie prevents cross-site forgery.
    const formCsrf = getField('csrf_token');
    const cookieCsrf = readCsrfCookie(req);
    if (!csrfMatches(formCsrf, cookieCsrf)) {
      sendJson(res, 403, {
        error: 'invalid_request',
        error_description: 'csrf_token mismatch',
      });
      return;
    }

    const email = getField('email').trim().toLowerCase();
    const api_key = getField('api_key');

    // Capacity check.
    if (pendingCodes.size >= MAX_PENDING_CODES) {
      sendJson(res, 503, {
        error: 'server_error',
        error_description: 'too many pending authorizations',
      });
      return;
    }

    // Allowlist check (uniform response regardless of email existence).
    if (!config.userStore.isAllowed(email)) {
      sendHtml(
        res,
        403,
        renderErrorPage({
          title: 'Access Denied',
          message: 'Your email is not authorized. Contact the administrator.',
        }),
      );
      return;
    }

    // Verify end-user Odoo credentials by calling the `common.authenticate`
    // service directly. Note: OdooClient.execute() routes everything through
    // `object.execute_kw`, which is for model methods — it CANNOT call the
    // `common` service. We use the raw jsonRpc helper instead.
    let uid: unknown;
    try {
      uid = await jsonRpc(config.odooUrl, '/jsonrpc', {
        service: 'common',
        method: 'authenticate',
        args: [config.odooDb, email, api_key, {}],
      });
    } catch {
      uid = null;
    }

    if (!uid) {
      // Re-render consent with error — do NOT log api_key. Issue a fresh
      // CSRF token so the next submit has a current cookie/form pair.
      // @ts-ignore — randomBytes imported above
      const csrfToken: string = randomBytes(32).toString('hex');
      const html = renderConsentPage({
        client_name: client.client_name,
        formAction: rawUrl,
        error: 'Invalid Odoo credentials',
        email,
        csrf_token: csrfToken,
      });
      sendConsentHtml(res, 200, html, csrfToken);
      return;
    }

    // Encrypt API key and generate auth code.
    const encrypted_api_key = config.encryptionService.encrypt(api_key);
    // @ts-ignore — randomBytes imported above
    const code: string = randomBytes(16).toString('hex');

    pendingCodes.set(code, {
      code,
      client_id: client.client_id,
      redirect_uri,
      code_challenge,
      encrypted_api_key,
      email,
      expires_at: Date.now() + 600_000,
      used: false,
    });

    // Redirect.
    const location = `${redirect_uri}?code=${code}&state=${encodeURIComponent(state)}`;
    // @ts-ignore — res methods available at runtime
    res.writeHead(302, { Location: location });
    // @ts-ignore — res.end available at runtime
    res.end();
  }

  // -------------------------------------------------------------------------
  // handleToken — POST /oauth/token
  // -------------------------------------------------------------------------

  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // @ts-ignore — req.method available at runtime
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    // Check Content-Type.
    // @ts-ignore — req.headers available at runtime
    const contentType: string = (req.headers?.['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded' && contentType !== 'application/json') {
      sendJson(res, 415, { error: 'unsupported_media_type' });
      return;
    }

    // Read body.
    let bodyText: string;
    try {
      bodyText = await readBody(req, BODY_READ_CAP);
    } catch {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'could not read request body',
      });
      return;
    }

    // Parse body.
    let fields: Record<string, string | string[] | undefined>;
    if (contentType === 'application/json') {
      try {
        fields = JSON.parse(bodyText) as Record<string, string | string[] | undefined>;
      } catch {
        sendJson(res, 400, {
          error: 'invalid_request',
          error_description: 'request body must be JSON',
        });
        return;
      }
    } else {
      // @ts-ignore — parseQs imported above
      fields = parseQs(bodyText) as Record<string, string | string[] | undefined>;
    }

    const getField = (key: string): string => {
      const v = fields[key];
      return (Array.isArray(v) ? v[0] : v) ?? '';
    };

    const code = getField('code');
    const code_verifier = getField('code_verifier');
    const client_id = getField('client_id');
    const redirect_uri = getField('redirect_uri');

    // Field length checks.
    if (code.length > 64 || code_verifier.length > 128 || client_id.length > 64) {
      sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'field length exceeded',
      });
      return;
    }

    // Lookup auth code.
    const pendingCode = pendingCodes.get(code);
    if (!pendingCode) {
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'authorization code expired',
      });
      return;
    }

    // Replay check.
    if (pendingCode.used) {
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'authorization code already used',
      });
      return;
    }

    // Expiry check.
    if (Date.now() > pendingCode.expires_at) {
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'authorization code expired',
      });
      return;
    }

    // Client match.
    if (pendingCode.client_id !== client_id) {
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'client_id mismatch',
      });
      return;
    }

    // Redirect URI match.
    if (pendingCode.redirect_uri !== redirect_uri) {
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'redirect_uri mismatch',
      });
      return;
    }

    // PKCE verification — timing-safe comparison.
    const computedChallenge = sha256Base64url(code_verifier);
    const storedChallenge = pendingCode.code_challenge;

    // Pad to equal length before timingSafeEqual.
    const computedBuf = Buffer.from(computedChallenge.padEnd(64, '='));
    const storedBuf = Buffer.from(storedChallenge.padEnd(64, '='));

    let challengeMatch = false;
    try {
      // @ts-ignore — timingSafeEqual imported above
      challengeMatch = timingSafeEqual(computedBuf, storedBuf);
    } catch {
      challengeMatch = false;
    }

    if (!challengeMatch) {
      sendJson(res, 400, {
        error: 'invalid_grant',
        error_description: 'code_verifier mismatch',
      });
      return;
    }

    // Mark as used.
    pendingCode.used = true;

    // Decrypt API key and register user.
    const apiKey = config.encryptionService.decrypt(pendingCode.encrypted_api_key);
    const access_token = await config.userStore.register(pendingCode.email, apiKey);

    // Audit log — do NOT log apiKey or access_token.
    process.stderr.write(
      `${JSON.stringify({
        event: 'token_issued',
        email: pendingCode.email,
        issued_at: new Date().toISOString(),
      })}\n`,
    );

    sendJson(res, 200, {
      access_token,
      token_type: 'bearer',
      scope: 'mcp',
    });
  }

  return { handleMetadata, handleResourceMetadata, handleRegister, handleAuthorize, handleToken };
}
