import { OdooMissingError } from '@netlinks/odoo-client';
import type { OdooClient, ProbeResult } from '@netlinks/odoo-client';

// Minimal ambient declaration — avoids @types/node dependency.
declare const process: { stderr: { write: (data: string) => boolean } };

// Upper bound on the modules-installed query. Typical Odoo deployments have
// 100-300 installed modules; 500 covers the largest production instances
// while still avoiding unbounded payloads if Odoo's search_read default ever
// changes.
const MODULE_PROBE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

// ---------------------------------------------------------------------------
// runProbe
// ---------------------------------------------------------------------------

/**
 * Runs 7 sub-queries in parallel via Promise.allSettled and assembles a
 * ProbeResult. Requires that client.authenticate() has already been called.
 *
 * Sub-queries (7 promises → 8 ProbeResult fields):
 *   1. modules        — ir.module.module
 *   2. reports        — ir.actions.report
 *   3. serverActions  — ir.actions.server
 *   4. companies      — res.company
 *   5. currencies     — res.currency
 *   6. fiscalYear     — account.fiscal.year (falls back to current year)
 *   7. userContext    — res.users.context_get → language + locale
 *
 * On total failure (all 7 promises rejected) writes a JSON warning to stderr.
 * Never throws.
 */
export async function runProbe(client: OdooClient): Promise<ProbeResult> {
  const currentYear = new Date().getFullYear();

  // -------------------------------------------------------------------
  // Promise 6: fiscalYear with internal fallback for missing model
  // -------------------------------------------------------------------
  const fiscalYearPromise: Promise<{ date_from: string; date_to: string }> = (async () => {
    try {
      const rows = await client.searchRead('account.fiscal.year', [], ['date_from', 'date_to'], {
        limit: 1,
      });
      const first = rows[0];
      if (first) {
        return {
          date_from: first.date_from as string,
          date_to: first.date_to as string,
        };
      }
      // Empty result — fall back to synthetic year
      return {
        date_from: `${currentYear}-01-01`,
        date_to: `${currentYear}-12-31`,
      };
    } catch (err) {
      if (err instanceof OdooMissingError) {
        // Model doesn't exist on this Odoo instance — return synthetic year
        return {
          date_from: `${currentYear}-01-01`,
          date_to: `${currentYear}-12-31`,
        };
      }
      throw err;
    }
  })();

  // -------------------------------------------------------------------
  // Promise 7: userContext — provides language + locale
  // -------------------------------------------------------------------
  const userContextPromise = client.execute('res.users', 'context_get', [], {}).then((result) => {
    const ctx = result as Record<string, unknown>;
    return {
      lang: (ctx.lang as string | undefined) ?? 'en_US',
      tz: (ctx.tz as string | undefined) ?? 'UTC',
    };
  });

  // -------------------------------------------------------------------
  // Fan-out: 7 promises
  // -------------------------------------------------------------------
  const [
    modulesResult,
    reportsResult,
    serverActionsResult,
    companiesResult,
    currenciesResult,
    fiscalYearResult,
    userContextResult,
  ] = await Promise.allSettled([
    // 1. modules
    client
      .searchRead('ir.module.module', [['state', '=', 'installed']], ['name', 'version'], {
        limit: MODULE_PROBE_LIMIT,
      })
      .then((rows) =>
        rows.map((r) => ({
          name: r.name as string,
          version: r.version as string,
        })),
      ),

    // 2. reports
    client
      .searchRead('ir.actions.report', [], ['report_name', 'model', 'report_type'])
      .then((rows) =>
        rows.map((r) => ({
          report_name: r.report_name as string,
          model: r.model as string,
          report_type: r.report_type as string,
        })),
      ),

    // 3. serverActions
    client
      .searchRead('ir.actions.server', [], ['name', 'model_id', 'type'])
      .then((rows) =>
        rows.map((r) => ({
          name: r.name as string,
          model: (r.model_id as [number, string])[1],
          type: r.type as string,
        })),
      ),

    // 4. companies
    client
      .searchRead('res.company', [], ['id', 'name', 'currency_id'])
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name as string,
          currency_id: r.currency_id as [number, string],
        })),
      ),

    // 5. currencies
    client
      .searchRead('res.currency', [['active', '=', true]], ['id', 'name', 'symbol'])
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          name: r.name as string,
          symbol: r.symbol as string,
        })),
      ),

    // 6. fiscalYear (internal fallback for OdooMissingError)
    fiscalYearPromise,

    // 7. userContext (language + locale)
    userContextPromise,
  ]);

  // -------------------------------------------------------------------
  // Threat-model US-3 AC-6: warn if all 7 promises failed
  // -------------------------------------------------------------------
  const succeeded = [
    modulesResult,
    reportsResult,
    serverActionsResult,
    companiesResult,
    currenciesResult,
    fiscalYearResult,
    userContextResult,
  ].filter((r) => r.status === 'fulfilled').length;

  if (succeeded === 0) {
    process.stderr.write(
      `${JSON.stringify({ event: 'warning', message: 'All probe sub-queries failed' })}\n`,
    );
  }

  // -------------------------------------------------------------------
  // Assemble ProbeResult
  // -------------------------------------------------------------------

  // language and locale share the userContext promise
  let language: string | { error: string };
  let locale: string | { error: string };
  if (userContextResult.status === 'fulfilled') {
    language = userContextResult.value.lang;
    locale = userContextResult.value.tz;
  } else {
    const errMsg = extractMessage(userContextResult.reason);
    language = { error: errMsg };
    locale = { error: errMsg };
  }

  return {
    modules:
      modulesResult.status === 'fulfilled'
        ? modulesResult.value
        : { error: extractMessage(modulesResult.reason) },

    reports:
      reportsResult.status === 'fulfilled'
        ? reportsResult.value
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

    language,
    locale,
  };
}
