import { type AuthStrategy, createAuthStrategy } from './auth.js';
import { OdooAuthError } from './errors.js';
import { jsonRpc } from './rpc.js';
import type { Context, Domain, OdooConfig, OdooRecord, OdooSession, ProbeResult } from './types.js';

const CALL_KW = '/web/dataset/call_kw';

function extractMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

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
      limit: limit ?? 80,
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

  // ---------------------------------------------------------------------------
  // Probe
  // ---------------------------------------------------------------------------

  async probe(): Promise<ProbeResult> {
    const session = this.requireSession();
    const currentYear = new Date().getFullYear();

    const [
      modulesResult,
      reportsResult,
      serverActionsResult,
      companiesResult,
      currenciesResult,
      fiscalYearResult,
      languageResult,
      localeResult,
    ] = await Promise.allSettled([
      // 1. modules
      this.searchRead(
        'ir.module.module',
        [['state', '=', 'installed']],
        ['name', 'latest_version'],
      ).then((rows) =>
        rows.map((r) => ({ name: r.name as string, version: r.latest_version as string })),
      ),
      // 2. reports
      this.searchRead('ir.actions.report', [], ['report_name', 'model', 'report_type']),
      // 3. serverActions
      this.searchRead('ir.actions.server', [], ['name', 'model_id', 'type']).then((rows) =>
        rows.map((r) => ({
          name: r.name as string,
          model: (r.model_id as [number, string])[1],
          type: r.type as string,
        })),
      ),
      // 4. companies
      this.searchRead('res.company', [], ['name', 'currency_id']).then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name as string,
          currency_id: r.currency_id as [number, string],
        })),
      ),
      // 5. currencies
      this.searchRead('res.currency', [], ['name', 'symbol']).then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name as string,
          symbol: r.symbol as string,
        })),
      ),
      // 6. fiscalYear — approximate using current calendar year
      this.read(
        'res.company',
        [session.companyId],
        ['fiscalyear_last_day', 'fiscalyear_last_month'],
      ).then(() => ({
        date_from: `${currentYear}-01-01`,
        date_to: `${currentYear}-12-31`,
      })),
      // 7. language
      this.read('res.users', [session.uid], ['lang']).then(
        (rows) => (rows[0] as unknown as { lang: string }).lang,
      ),
      // 8. locale (timezone as proxy)
      this.read('res.users', [session.uid], ['tz']).then(
        (rows) => (rows[0] as unknown as { tz: string }).tz,
      ),
    ]);

    return {
      modules:
        modulesResult.status === 'fulfilled'
          ? modulesResult.value
          : { error: extractMessage(modulesResult.reason) },
      reports:
        reportsResult.status === 'fulfilled'
          ? (reportsResult.value as unknown as Array<{
              report_name: string;
              model: string;
              report_type: string;
            }>)
          : { error: extractMessage(reportsResult.reason) },
      serverActions:
        serverActionsResult.status === 'fulfilled'
          ? serverActionsResult.value
          : { error: extractMessage(serverActionsResult.reason) },
      companies:
        companiesResult.status === 'fulfilled'
          ? companiesResult.value
          : { error: extractMessage(companiesResult.reason) },
      currencies:
        currenciesResult.status === 'fulfilled'
          ? currenciesResult.value
          : { error: extractMessage(currenciesResult.reason) },
      fiscalYear:
        fiscalYearResult.status === 'fulfilled'
          ? fiscalYearResult.value
          : { error: extractMessage(fiscalYearResult.reason) },
      language:
        languageResult.status === 'fulfilled'
          ? languageResult.value
          : { error: extractMessage(languageResult.reason) },
      locale:
        localeResult.status === 'fulfilled'
          ? localeResult.value
          : { error: extractMessage(localeResult.reason) },
    };
  }
}
