import { type AuthStrategy, createAuthStrategy } from './auth.js';
import { OdooAuthError } from './errors.js';
import { jsonRpc } from './rpc.js';
import type { Context, Domain, OdooConfig, OdooRecord, OdooSession } from './types.js';

const CALL_KW = '/web/dataset/call_kw';

// US-4 AC-9: searchRead applies an 80-row default to prevent unbounded payloads.
const DEFAULT_SEARCH_LIMIT = 80;

/** Remove undefined-valued keys from a shallow object, returning a new object */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) result[k] = v;
  }
  return result;
}

export class OdooClient {
  private session?: OdooSession;
  private strategy?: AuthStrategy;

  constructor(private readonly config: OdooConfig) {}

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async authenticate(): Promise<OdooSession> {
    const strategy = await createAuthStrategy(this.config);
    const session = await strategy.authenticate(this.config);
    this.strategy = strategy;
    this.session = session;
    return session;
  }

  // ---------------------------------------------------------------------------
  // Guard
  // ---------------------------------------------------------------------------

  private requireSession(): OdooSession {
    if (!this.session) {
      throw new OdooAuthError('Not authenticated — call authenticate() first');
    }
    return this.session;
  }

  // ---------------------------------------------------------------------------
  // ORM methods
  // ---------------------------------------------------------------------------

  async searchRead(
    model: string,
    domain: Domain,
    fields?: string[],
    options?: { limit?: number; offset?: number; order?: string; context?: Context },
  ): Promise<OdooRecord[]> {
    this.requireSession();
    const { limit, offset, order, context } = options ?? {};
    const kwargs = compact({
      fields,
      limit: limit ?? DEFAULT_SEARCH_LIMIT,
      offset,
      order,
      context,
    });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'search_read',
      args: [domain],
      kwargs,
    });
    return result as OdooRecord[];
  }

  async read(
    model: string,
    ids: number[],
    fields?: string[],
    context?: Context,
  ): Promise<OdooRecord[]> {
    this.requireSession();
    const kwargs = compact({ fields, context });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'read',
      args: [ids],
      kwargs,
    });
    return result as OdooRecord[];
  }

  async create(
    model: string,
    values: Record<string, unknown> | Record<string, unknown>[],
    context?: Context,
  ): Promise<number | number[]> {
    this.requireSession();
    const kwargs = compact({ context });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'create',
      args: [values],
      kwargs,
    });
    return result as number | number[];
  }

  async write(
    model: string,
    ids: number[],
    values: Record<string, unknown>,
    context?: Context,
  ): Promise<boolean> {
    this.requireSession();
    const kwargs = compact({ context });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'write',
      args: [ids, values],
      kwargs,
    });
    return result as boolean;
  }

  async unlink(model: string, ids: number[], context?: Context): Promise<boolean> {
    this.requireSession();
    const kwargs = compact({ context });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'unlink',
      args: [ids],
      kwargs,
    });
    return result as boolean;
  }

  async searchCount(model: string, domain: Domain, context?: Context): Promise<number> {
    this.requireSession();
    const kwargs = compact({ context });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'search_count',
      args: [domain],
      kwargs,
    });
    return result as number;
  }

  async execute(
    model: string,
    method: string,
    args?: unknown[],
    kwargs?: Record<string, unknown>,
    context?: Context,
  ): Promise<unknown> {
    this.requireSession();
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method,
      args: args ?? [],
      kwargs: { ...(kwargs ?? {}), context },
    });
    return result;
  }

  async runReport(
    reportId: number | string,
    docIds: number[],
    context?: Context,
  ): Promise<{ content: string; contentType: 'application/pdf' }> {
    this.requireSession();
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model: 'ir.actions.report',
      method: '_render_qweb_pdf',
      args: [reportId, docIds],
      kwargs: compact({ context }),
    });
    // Odoo returns [content_base64, content_type] tuple
    const tuple = result as [string, string];
    return { content: tuple[0], contentType: 'application/pdf' };
  }

  async callAction(
    model: string,
    ids: number[],
    actionName: string,
    context?: Context,
  ): Promise<unknown> {
    return this.execute(model, actionName, [ids], {}, context);
  }

  async fieldsGet(
    model: string,
    attributes?: string[],
    context?: Context,
  ): Promise<Record<string, unknown>> {
    this.requireSession();
    const kwargs = compact({ allfields: attributes ?? [], context });
    const result = await jsonRpc(this.config.url, CALL_KW, {
      model,
      method: 'fields_get',
      args: [],
      kwargs,
    });
    return result as Record<string, unknown>;
  }
}
// Note: capability probing is implemented in @netlinksinc/odoo-mcp's probe.ts
// (the runProbe function) which uses this client's searchRead/execute methods.
// An earlier probe() method on OdooClient was removed during v0.1 hardening
// because it duplicated runProbe and was never called from the server path.
