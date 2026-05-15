import { describe, it, expect } from 'vitest';
import type { OdooSession } from '@netlinks/odoo-client';
import { OdooError } from '@netlinks/odoo-client';
import { buildContext, validateCompanySubset } from '../src/context.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const SESSION: OdooSession = {
  uid: 7,
  companyId: 1,
  allowedCompanyIds: [1, 2, 3],
  userContext: { lang: 'en_US', tz: 'UTC' },
};

// ---------------------------------------------------------------------------
// buildContext
// ---------------------------------------------------------------------------

describe('buildContext — session-authoritative field enforcement', () => {
  it('AC-1: extraContext.uid is overridden by session.uid', () => {
    const ctx = buildContext(SESSION, {}, { uid: 999 });
    expect(ctx.uid).toBe(SESSION.uid); // must be 7, NOT 999
  });

  it('AC-2: extraContext.allowed_company_ids is overridden by session value', () => {
    const ctx = buildContext(SESSION, {}, { allowed_company_ids: [999] });
    expect(ctx.allowed_company_ids).toEqual(SESSION.allowedCompanyIds);
  });

  it('company_id from extraContext is overridden by session.companyId', () => {
    const ctx = buildContext(SESSION, {}, { company_id: 42 });
    expect(ctx.company_id).toBe(SESSION.companyId); // must be 1, NOT 42
  });

  it('non-conflicting extraContext fields are preserved', () => {
    const ctx = buildContext(SESSION, {}, { invoice_journal_id: 5 });
    expect(ctx.invoice_journal_id).toBe(5);
    expect(ctx.lang).toBe('en_US'); // from userContext
  });
});

describe('buildContext — companyArgs override session defaults', () => {
  it('companyArgs.allowed_company_ids overrides session.allowedCompanyIds', () => {
    const ctx = buildContext(SESSION, { allowed_company_ids: [1, 2] });
    expect(ctx.allowed_company_ids).toEqual([1, 2]);
  });

  it('companyArgs.active_company_id overrides session.companyId', () => {
    const ctx = buildContext(SESSION, { active_company_id: 2 });
    expect(ctx.company_id).toBe(2);
  });

  it('companyArgs values still win over extraContext when both present', () => {
    const ctx = buildContext(
      SESSION,
      { allowed_company_ids: [1] },
      { allowed_company_ids: [999] },
    );
    // companyArgs-derived value wins (it's applied last as authoritative)
    expect(ctx.allowed_company_ids).toEqual([1]);
  });
});

describe('buildContext — userContext fields are present', () => {
  it('lang and tz from session.userContext appear in output', () => {
    const ctx = buildContext(SESSION, {});
    expect(ctx.lang).toBe('en_US');
    expect(ctx.tz).toBe('UTC');
  });

  it('no extraContext still produces correct uid and company fields', () => {
    const ctx = buildContext(SESSION, {});
    expect(ctx.uid).toBe(7);
    expect(ctx.company_id).toBe(1);
    expect(ctx.allowed_company_ids).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// validateCompanySubset
// ---------------------------------------------------------------------------

describe('validateCompanySubset', () => {
  it('AC-3: does not throw when all callerIds are in sessionIds', () => {
    expect(() => validateCompanySubset([1, 2], [1, 2, 3])).not.toThrow();
  });

  it('AC-4: throws OdooError with errorType InputValidationError for missing id', () => {
    let caught: unknown;
    try {
      validateCompanySubset([1, 99], [1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OdooError);
    expect((caught as OdooError).errorType).toBe('InputValidationError');
  });

  it('error message includes the offending company ID', () => {
    expect(() => validateCompanySubset([1, 99], [1, 2, 3])).toThrowError('99');
  });

  it('multiple missing IDs are all listed in the error message', () => {
    let caught: unknown;
    try {
      validateCompanySubset([1, 88, 99], [1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect((caught as OdooError).message).toContain('88');
    expect((caught as OdooError).message).toContain('99');
  });

  it('does not throw for empty callerIds', () => {
    expect(() => validateCompanySubset([], [1, 2, 3])).not.toThrow();
  });

  it('throws when sessionIds is empty and callerIds is non-empty', () => {
    expect(() => validateCompanySubset([1], [])).toThrow();
  });
});
