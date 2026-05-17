import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OdooClient } from '@netlinksinc/odoo-client';
import { OdooMissingError } from '@netlinksinc/odoo-client';
import { runProbe } from '../src/probe.js';

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

/** Build a minimal OdooClient mock with all methods used by runProbe. */
function makeClientMock(): OdooClient {
  return {
    searchRead: vi.fn(),
    execute: vi.fn(),
  } as unknown as OdooClient;
}

// ---------------------------------------------------------------------------
// Shared valid return values
// ---------------------------------------------------------------------------

const MODULES = [{ id: 1, name: 'base', version: '17.0.1.0.0' }];
const REPORTS = [{ id: 1, report_name: 'sale.report_saleorder', model: 'sale.order', report_type: 'qweb-pdf' }];
const SERVER_ACTIONS = [{ id: 1, name: 'Send Email', model_id: [3, 'res.partner'], type: 'ir.actions.server' }];
const COMPANIES = [{ id: 1, name: 'NETLINKS', currency_id: [2, 'USD'] }];
const CURRENCIES = [{ id: 2, name: 'USD', symbol: '$' }];
const FISCAL_YEAR_ROWS = [{ id: 1, date_from: '2026-01-01', date_to: '2026-12-31' }];
const USER_CONTEXT = { lang: 'fr_FR', tz: 'Europe/Paris' };

function setupAllSucceed(client: OdooClient) {
  const sr = vi.mocked(client.searchRead);
  sr.mockImplementation(async (model: string) => {
    if (model === 'ir.module.module') return MODULES;
    if (model === 'ir.actions.report') return REPORTS;
    if (model === 'ir.actions.server') return SERVER_ACTIONS;
    if (model === 'res.company') return COMPANIES;
    if (model === 'res.currency') return CURRENCIES;
    if (model === 'account.fiscal.year') return FISCAL_YEAR_ROWS;
    return [];
  });
  vi.mocked(client.execute).mockResolvedValue(USER_CONTEXT);
}

// ---------------------------------------------------------------------------
// AC-1: All 7 sub-queries succeed — 8 fields populated correctly
// ---------------------------------------------------------------------------

describe('runProbe — all sub-queries succeed (AC-1)', () => {
  let client: OdooClient;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClientMock();
    setupAllSucceed(client);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns modules array with name and version', async () => {
    const result = await runProbe(client);
    expect(Array.isArray(result.modules)).toBe(true);
    const modules = result.modules as Array<{ name: string; version: string }>;
    expect(modules[0]).toEqual({ name: 'base', version: '17.0.1.0.0' });
  });

  it('returns reports array with report_name, model, report_type', async () => {
    const result = await runProbe(client);
    expect(Array.isArray(result.reports)).toBe(true);
    const reports = result.reports as Array<{ report_name: string; model: string; report_type: string }>;
    expect(reports[0]).toEqual({
      report_name: 'sale.report_saleorder',
      model: 'sale.order',
      report_type: 'qweb-pdf',
    });
  });

  it('maps serverActions model_id[1] to model string', async () => {
    const result = await runProbe(client);
    expect(Array.isArray(result.serverActions)).toBe(true);
    const sa = result.serverActions as Array<{ name: string; model: string; type: string }>;
    expect(sa[0]?.model).toBe('res.partner');
  });

  it('returns companies with id, name, currency_id tuple', async () => {
    const result = await runProbe(client);
    const companies = result.companies as Array<{ id: number; name: string; currency_id: [number, string] }>;
    expect(companies[0]).toEqual({ id: 1, name: 'NETLINKS', currency_id: [2, 'USD'] });
  });

  it('returns currencies with id, name, symbol', async () => {
    const result = await runProbe(client);
    const currencies = result.currencies as Array<{ id: number; name: string; symbol: string }>;
    expect(currencies[0]).toEqual({ id: 2, name: 'USD', symbol: '$' });
  });

  it('returns fiscalYear with date_from and date_to from account.fiscal.year', async () => {
    const result = await runProbe(client);
    expect(result.fiscalYear).toEqual({ date_from: '2026-01-01', date_to: '2026-12-31' });
  });

  it('returns language string from context_get', async () => {
    const result = await runProbe(client);
    expect(result.language).toBe('fr_FR');
  });

  it('returns locale (tz) string from context_get', async () => {
    const result = await runProbe(client);
    expect(result.locale).toBe('Europe/Paris');
  });

  it('does not write to stderr when all succeed', async () => {
    await runProbe(client);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-2: ir.actions.report rejects — only reports field is error
// ---------------------------------------------------------------------------

describe('runProbe — ir.actions.report rejects (AC-2)', () => {
  let client: OdooClient;

  beforeEach(() => {
    client = makeClientMock();
    setupAllSucceed(client);
    // Override reports to reject
    vi.mocked(client.searchRead).mockImplementation(async (model: string) => {
      if (model === 'ir.actions.report') throw new Error('access denied');
      if (model === 'ir.module.module') return MODULES;
      if (model === 'ir.actions.server') return SERVER_ACTIONS;
      if (model === 'res.company') return COMPANIES;
      if (model === 'res.currency') return CURRENCIES;
      if (model === 'account.fiscal.year') return FISCAL_YEAR_ROWS;
      return [];
    });
    vi.mocked(client.execute).mockResolvedValue(USER_CONTEXT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports field is { error: string }', async () => {
    const result = await runProbe(client);
    expect(result.reports).toEqual({ error: 'access denied' });
  });

  it('other fields are unaffected — modules is still an array', async () => {
    const result = await runProbe(client);
    expect(Array.isArray(result.modules)).toBe(true);
  });

  it('other fields are unaffected — companies is still an array', async () => {
    const result = await runProbe(client);
    expect(Array.isArray(result.companies)).toBe(true);
  });

  it('other fields are unaffected — language is still a string', async () => {
    const result = await runProbe(client);
    expect(result.language).toBe('fr_FR');
  });
});

// ---------------------------------------------------------------------------
// AC-3: All 7 sub-queries reject — all 8 fields are { error }, function
//        resolves, writes warning to stderr
// ---------------------------------------------------------------------------

describe('runProbe — all sub-queries reject (AC-3)', () => {
  let client: OdooClient;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = makeClientMock();
    vi.mocked(client.searchRead).mockRejectedValue(new Error('network error'));
    vi.mocked(client.execute).mockRejectedValue(new Error('network error'));
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves (does not throw)', async () => {
    await expect(runProbe(client)).resolves.toBeDefined();
  });

  it('all 8 fields are { error: string }', async () => {
    const result = await runProbe(client);
    const fields: (keyof typeof result)[] = [
      'modules',
      'reports',
      'serverActions',
      'companies',
      'currencies',
      'fiscalYear',
      'language',
      'locale',
    ];
    for (const field of fields) {
      expect(result[field]).toHaveProperty('error');
      expect(typeof (result[field] as { error: string }).error).toBe('string');
    }
  });

  it('writes all-failed warning JSON to stderr', async () => {
    await runProbe(client);
    expect(stderrSpy).toHaveBeenCalled();
    const writes = stderrSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const aggregateWarning = writes.find(
      (p) => p.event === 'warning' && p.message === 'All probe sub-queries failed',
    );
    expect(aggregateWarning).toBeDefined();
  });

  it('writes per-field probe_failed entries when sub-queries reject', async () => {
    await runProbe(client);
    const writes = stderrSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const failureFields = writes.filter((p) => p.event === 'probe_failed').map((p) => p.field);
    // All 7 sub-queries fail in this test, so we expect 7 probe_failed entries
    expect(failureFields).toEqual(
      expect.arrayContaining([
        'modules',
        'reports',
        'serverActions',
        'companies',
        'currencies',
        'fiscalYear',
        'userContext',
      ]),
    );
  });

  it('stderr warning is valid JSON ending with newline', async () => {
    await runProbe(client);
    const written = stderrSpy.mock.calls[0]?.[0] as string;
    expect(written.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(written)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fiscalYear fallback: OdooMissingError → synthetic calendar year
// ---------------------------------------------------------------------------

describe('runProbe — fiscalYear OdooMissingError fallback', () => {
  let client: OdooClient;

  beforeEach(() => {
    client = makeClientMock();
    setupAllSucceed(client);
    // Override account.fiscal.year to throw OdooMissingError
    vi.mocked(client.searchRead).mockImplementation(async (model: string) => {
      if (model === 'account.fiscal.year')
        throw new OdooMissingError('Model account.fiscal.year does not exist');
      if (model === 'ir.module.module') return MODULES;
      if (model === 'ir.actions.report') return REPORTS;
      if (model === 'ir.actions.server') return SERVER_ACTIONS;
      if (model === 'res.company') return COMPANIES;
      if (model === 'res.currency') return CURRENCIES;
      return [];
    });
    vi.mocked(client.execute).mockResolvedValue(USER_CONTEXT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fiscalYear falls back to current-year synthetic dates', async () => {
    const result = await runProbe(client);
    const year = new Date().getFullYear();
    expect(result.fiscalYear).toEqual({
      date_from: `${year}-01-01`,
      date_to: `${year}-12-31`,
    });
  });

  it('other fields are unaffected when only fiscalYear falls back', async () => {
    const result = await runProbe(client);
    expect(Array.isArray(result.modules)).toBe(true);
    expect(Array.isArray(result.reports)).toBe(true);
    expect(result.language).toBe('fr_FR');
  });
});

// ---------------------------------------------------------------------------
// userContext defaults: context_get returns no lang/tz
// ---------------------------------------------------------------------------

describe('runProbe — userContext missing lang/tz defaults to en_US / UTC', () => {
  let client: OdooClient;

  beforeEach(() => {
    client = makeClientMock();
    setupAllSucceed(client);
    // context_get returns an empty object
    vi.mocked(client.execute).mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('language defaults to en_US when lang is absent', async () => {
    const result = await runProbe(client);
    expect(result.language).toBe('en_US');
  });

  it('locale defaults to UTC when tz is absent', async () => {
    const result = await runProbe(client);
    expect(result.locale).toBe('UTC');
  });
});
