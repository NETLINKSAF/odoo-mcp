// Minimal ambient declaration so tsc resolves `process` without @types/node.
declare const process: { stderr: { write: (data: string) => boolean } };

import { OdooAuthError, OdooConnectionError, OdooError } from './errors.js';
import { type JsonRpcRequest, REQUEST_TIMEOUT_MS, jsonRpc } from './rpc.js';
import type { Context, OdooConfig, OdooSession } from './types.js';

/**
 * Pluggable Odoo authentication interface. Two strategies ship out of the
 * box: ApiKeyAuthStrategy (preferred) and SessionCookieAuthStrategy (fallback).
 *
 * `authenticate(config)` performs the login round-trip and returns the populated
 * OdooSession.
 *
 * `applyAuth(request, session)` is a structural extension point. Both shipped
 * strategies return the request unchanged because JsonRpcRequest carries no
 * `headers` field — cookie/session-id injection happens at the call site,
 * via the headers arg to `jsonRpc()`. Custom strategies that want to mutate
 * the request envelope itself can do so here.
 */
export interface AuthStrategy {
  authenticate(config: OdooConfig): Promise<OdooSession>;
  applyAuth(request: JsonRpcRequest, session: OdooSession): JsonRpcRequest;
}

/** Extract and validate the session fields from a raw authenticate result */
function extractSession(raw: unknown): OdooSession {
  if (raw === null || typeof raw !== 'object') {
    throw new OdooAuthError('Invalid authenticate response: expected object');
  }
  const r = raw as Record<string, unknown>;

  const uid = r.uid;
  if (typeof uid !== 'number') {
    throw new OdooAuthError('Invalid authenticate response: missing uid');
  }

  const companyId = r.company_id;
  if (typeof companyId !== 'number') {
    throw new OdooAuthError('Invalid authenticate response: missing company_id');
  }

  const rawAllowed = r.allowed_company_ids;
  if (!Array.isArray(rawAllowed)) {
    throw new OdooAuthError('Invalid authenticate response: missing allowed_company_ids');
  }
  const allowedCompanyIds = rawAllowed as number[];

  const userContext = r.user_context;
  if (userContext === null || typeof userContext !== 'object' || Array.isArray(userContext)) {
    throw new OdooAuthError('Invalid authenticate response: missing user_context');
  }

  return {
    uid,
    companyId,
    allowedCompanyIds,
    userContext: userContext as Context,
  };
}

export class ApiKeyAuthStrategy implements AuthStrategy {
  async authenticate(config: OdooConfig): Promise<OdooSession> {
    const result = await jsonRpc(config.url, '/web/session/authenticate', {
      db: config.db,
      login: config.username,
      password: config.apiKey,
    });
    return extractSession(result);
  }

  applyAuth(request: JsonRpcRequest, session: OdooSession): JsonRpcRequest {
    if (!session.sessionId) {
      return request;
    }
    // JsonRpcRequest does not carry headers; return as-is — callers pass headers separately via jsonRpc
    return request;
  }
}

/**
 * SessionCookieAuthStrategy — fallback when API-key auth is unavailable.
 *
 * Calls fetch directly (mirroring jsonRpc's request shape) so it can read
 * the Set-Cookie header from the response and extract the session_id token.
 * applyAuth then injects `Cookie: session_id=<value>` into the headers map
 * that the caller passes to jsonRpc as its 4th argument.
 */
export class SessionCookieAuthStrategy implements AuthStrategy {
  async authenticate(config: OdooConfig): Promise<OdooSession> {
    const body = {
      jsonrpc: '2.0' as const,
      method: 'call' as const,
      id: Date.now(),
      params: {
        db: config.db,
        login: config.username,
        password: config.apiKey,
      },
    };

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.url}/web/session/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OdooConnectionError('Request timeout after 30s');
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new OdooConnectionError(message);
    }

    clearTimeout(timeoutHandle);

    const json = (await response.json()) as {
      jsonrpc: '2.0';
      id: number;
      result?: unknown;
      error?: {
        code: number;
        message: string;
        data: { name: string; message: string; debug: string };
      };
    };

    if (json.error) {
      const { name, message, debug } = json.error.data;
      if (name === 'odoo.exceptions.AccessDenied') {
        throw new OdooAuthError(message, debug);
      }
      throw new OdooError('ServerError', message, undefined, undefined, debug);
    }

    const session = extractSession(json.result);

    // Parse session_id from Set-Cookie header
    const setCookie = response.headers.get('set-cookie') ?? '';
    const match = /session_id=([^;]+)/.exec(setCookie);
    if (match) {
      session.sessionId = match[1];
    }

    return session;
  }

  applyAuth(request: JsonRpcRequest, session: OdooSession): JsonRpcRequest {
    // Headers are passed separately to jsonRpc; this method returns the request
    // unchanged. The caller is expected to build headers using session.sessionId.
    // We return the request unmodified — cookie injection happens at the call site.
    return request;
  }
}

/**
 * Factory: tries ApiKeyAuthStrategy; falls back to SessionCookieAuthStrategy on
 * OdooAuthError. Writes a plaintext-warning to stderr when url is http://.
 */
export async function createAuthStrategy(config: OdooConfig): Promise<AuthStrategy> {
  if (config.url.startsWith('http://')) {
    process.stderr.write(
      `${JSON.stringify({
        event: 'warning',
        message: 'ODOO_URL uses http:// — credentials transmitted in plaintext',
      })}\n`,
    );
  }

  const apiKey = new ApiKeyAuthStrategy();
  try {
    await apiKey.authenticate(config);
    return apiKey;
  } catch (err: unknown) {
    if (err instanceof OdooAuthError) {
      const cookie = new SessionCookieAuthStrategy();
      await cookie.authenticate(config);
      return cookie;
    }
    throw err;
  }
}
