// Minimal ambient declaration so tsc resolves `process` without @types/node.
declare const process: { stderr: { write: (data: string) => boolean } };

import { OdooAuthError, OdooConnectionError, OdooError } from './errors.js';
import { type JsonRpcRequest, REQUEST_TIMEOUT_MS, jsonRpc } from './rpc.js';
import type { Context, OdooConfig, OdooSession } from './types.js';

/**
 * Pluggable Odoo authentication interface. Two strategies ship out of the
 * box: ApiKeyAuthStrategy (preferred) and SessionCookieAuthStrategy (legacy
 * fallback, kept for completeness but unused by createAuthStrategy on the
 * primary path).
 *
 * `authenticate(config)` performs the login round-trip and returns the populated
 * OdooSession.
 *
 * `applyAuth(request, session)` is a structural extension point — the shipped
 * strategies return the request unchanged because authentication is folded
 * into every /jsonrpc call by way of the `[db, uid, api_key, …]` args array.
 */
export interface AuthStrategy {
  authenticate(config: OdooConfig): Promise<OdooSession>;
  applyAuth(request: JsonRpcRequest, session: OdooSession): JsonRpcRequest;
}

// ---------------------------------------------------------------------------
// Wire helpers for Odoo's classic /jsonrpc endpoint
// ---------------------------------------------------------------------------
// /jsonrpc takes `{ service, method, args }` where args is a positional array.
// `common.authenticate(db, login, password, user_agent_env)` returns either a
// uid integer on success or `false` on auth failure (NOT an error object).
// `object.execute_kw(db, uid, password, model, method, args, kwargs)` is the
// generic ORM invocation path.

const JSONRPC = '/jsonrpc';

async function commonAuthenticate(
  url: string,
  db: string,
  login: string,
  password: string,
): Promise<number> {
  const result = await jsonRpc(url, JSONRPC, {
    service: 'common',
    method: 'authenticate',
    args: [db, login, password, {}],
  });
  // Odoo returns the uid on success, `false` on failure
  if (result === false || result === null || typeof result !== 'number') {
    throw new OdooAuthError('Access Denied — login or API key rejected');
  }
  return result;
}

async function executeKw(
  url: string,
  db: string,
  uid: number,
  password: string,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown>,
): Promise<unknown> {
  return jsonRpc(url, JSONRPC, {
    service: 'object',
    method: 'execute_kw',
    args: [db, uid, password, model, method, args, kwargs],
  });
}

/** Fetch the minimum user metadata needed to populate the OdooSession. */
async function loadSessionMetadata(
  url: string,
  db: string,
  uid: number,
  password: string,
): Promise<{ companyId: number; allowedCompanyIds: number[]; userContext: Context }> {
  // First call: read company_id / company_ids from res.users
  const rows = (await executeKw(
    url,
    db,
    uid,
    password,
    'res.users',
    'read',
    [[uid], ['company_id', 'company_ids']],
    {},
  )) as Array<{ company_id?: [number, string]; company_ids?: number[] }>;

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new OdooAuthError(`Authenticated as uid=${uid} but res.users.read returned no row`);
  }
  const row = rows[0];
  if (!row.company_id || !row.company_ids) {
    throw new OdooAuthError('Authenticated but res.users row missing company_id / company_ids');
  }
  const companyId = row.company_id[0];
  const allowedCompanyIds = row.company_ids;

  // Second call: context_get returns lang, tz, uid, and any installed modules' context keys
  const userContext = (await executeKw(
    url,
    db,
    uid,
    password,
    'res.users',
    'context_get',
    [],
    {},
  )) as Context;

  return { companyId, allowedCompanyIds, userContext };
}

/**
 * Primary auth strategy: uses Odoo's classic /jsonrpc external-API endpoints
 * (`common.authenticate` + `object.execute_kw`). API keys are passed as the
 * password parameter on every call — there is no server-side session cookie.
 *
 * This is the only flow that works with API-key auth across all modern Odoo
 * configurations. The earlier `/web/session/authenticate` flow only works
 * when the user's web password happens to equal the value passed in
 * ODOO_API_KEY — a rare configuration.
 */
export class ApiKeyAuthStrategy implements AuthStrategy {
  async authenticate(config: OdooConfig): Promise<OdooSession> {
    const uid = await commonAuthenticate(config.url, config.db, config.username, config.apiKey);
    const { companyId, allowedCompanyIds, userContext } = await loadSessionMetadata(
      config.url,
      config.db,
      uid,
      config.apiKey,
    );
    return { uid, companyId, allowedCompanyIds, userContext };
  }

  applyAuth(request: JsonRpcRequest, _session: OdooSession): JsonRpcRequest {
    // No-op: auth is folded into every /jsonrpc call via the args array.
    return request;
  }
}

/**
 * Legacy fallback strategy. Targets `/web/session/authenticate`, which only
 * works when the user's web password equals the value passed in ODOO_API_KEY.
 * Retained for the rare case where an Odoo instance has been configured that
 * way; not used by the primary createAuthStrategy code path going forward.
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
      result?: {
        uid?: number;
        company_id?: number;
        allowed_company_ids?: number[];
        user_context?: Context;
      };
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

    const result = json.result;
    if (!result || typeof result.uid !== 'number') {
      throw new OdooAuthError('web/session/authenticate returned no uid');
    }
    return {
      uid: result.uid,
      companyId: result.company_id ?? 1,
      allowedCompanyIds: result.allowed_company_ids ?? [result.company_id ?? 1],
      userContext: result.user_context ?? {},
    };
  }

  applyAuth(request: JsonRpcRequest, _session: OdooSession): JsonRpcRequest {
    return request;
  }
}

/**
 * Factory: uses ApiKeyAuthStrategy (classic /jsonrpc external API). Writes a
 * plaintext warning to stderr when the URL is http:// per US-2 AC-5.
 *
 * Note: SessionCookieAuthStrategy is no longer attempted as a fallback because
 * /web/session/authenticate is incompatible with API-key auth on modern Odoo
 * instances. If callers explicitly need cookie auth, they can instantiate
 * SessionCookieAuthStrategy directly.
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
  return new ApiKeyAuthStrategy();
}
