import type { CompanyContext, Context, OdooSession } from '@netlinksinc/odoo-client';
import { OdooError } from '@netlinksinc/odoo-client';

/**
 * Build an Odoo RPC context from a session, company args, and optional caller-supplied extras.
 *
 * Threat-model enforcement (US-7 AC-7): session-authoritative fields (uid,
 * allowed_company_ids, company_id) are applied LAST so no caller-supplied
 * extraContext value can override them.
 */
export function buildContext(
  session: OdooSession,
  companyArgs: CompanyContext,
  extraContext?: Context,
): Context {
  // Resolve authoritative company/user values from session + companyArgs.
  const allowed_company_ids = companyArgs.allowed_company_ids ?? session.allowedCompanyIds;
  const company_id = companyArgs.active_company_id ?? session.companyId;
  const uid = session.uid;

  // Merge: session userContext → optional extraContext → authoritative fields.
  const base: Context = { ...session.userContext };
  const merged: Context = extraContext ? { ...base, ...extraContext } : base;

  return {
    ...merged,
    // Re-apply authoritative fields last — cannot be overridden by extraContext.
    uid,
    allowed_company_ids,
    company_id,
  };
}

/**
 * Assert that every caller-requested company ID is present in the session's
 * allowed set. Throws OdooError with errorType 'InputValidationError' on
 * failure so that formatMcpError surfaces the right error_type to Claude.
 */
export function validateCompanySubset(callerIds: number[], sessionIds: number[]): void {
  const sessionSet = new Set(sessionIds);
  const missing = callerIds.filter((id) => !sessionSet.has(id));
  if (missing.length > 0) {
    throw new OdooError(
      'InputValidationError',
      `InputValidationError: company ID not in session allowedCompanyIds: ${missing.join(', ')}`,
    );
  }
}
