/** Odoo domain filter element */
export type DomainOperator =
  | '='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'like'
  | 'ilike'
  | 'not like'
  | 'not ilike'
  | '=like'
  | '=ilike'
  | 'in'
  | 'not in'
  | 'child_of'
  | 'parent_of';
export type DomainLeaf = [field: string, operator: DomainOperator, value: unknown];
export type DomainConnector = '&' | '|' | '!';
export type Domain = Array<DomainLeaf | DomainConnector>;

/** Odoo context dict — always serialized as JSON object */
export type Context = Record<string, unknown>;

/** Generic Odoo record — field names to values */
export type OdooRecord = Record<string, unknown> & { id: number };

/** Connection configuration */
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  apiKey: string;
}

/** Session data returned after authentication */
export interface OdooSession {
  uid: number;
  sessionId?: string; // present if cookie-auth mode
  companyId: number;
  allowedCompanyIds: number[];
  userContext: Context;
}

/** Multi-company context args accepted by every tool */
export interface CompanyContext {
  allowed_company_ids?: number[];
  active_company_id?: number;
}

/** Probe results */
export interface ProbeResult {
  modules: Array<{ name: string; version: string }> | { error: string };
  reports: Array<{ report_name: string; model: string; report_type: string }> | { error: string };
  serverActions: Array<{ name: string; model: string; type: string }> | { error: string };
  companies: Array<{ id: number; name: string; currency_id: [number, string] }> | { error: string };
  currencies: Array<{ id: number; name: string; symbol: string }> | { error: string };
  fiscalYear: { date_from: string; date_to: string } | { error: string };
  language: string | { error: string };
  locale: string | { error: string };
}
