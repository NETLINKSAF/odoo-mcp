import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  searchReadSchema,
  readSchema,
  createSchema,
  writeSchema,
  unlinkSchema,
  searchCountSchema,
  executeSchema,
  runReportSchema,
  callActionSchema,
  fieldsGetSchema,
} from '../../src/tools/schemas.js';

describe('searchReadSchema', () => {
  it('AC-1: parses minimal input with correct defaults', () => {
    const result = searchReadSchema.parse({ model: 'res.partner' });
    expect(result.model).toBe('res.partner');
    expect(result.domain).toEqual([]);
    expect(result.fields).toEqual([]);
    expect(result.limit).toBe(80);
    expect(result.offset).toBe(0);
    expect(result.allowed_company_ids).toBeUndefined();
    expect(result.active_company_id).toBeUndefined();
  });

  it('AC-2: throws ZodError for empty model string', () => {
    expect(() => searchReadSchema.parse({ model: '' })).toThrow(ZodError);
  });

  it('passes all fields when provided', () => {
    const result = searchReadSchema.parse({
      model: 'sale.order',
      domain: [['state', '=', 'sale']],
      fields: ['name', 'partner_id'],
      limit: 10,
      offset: 5,
      order: 'name asc',
      allowed_company_ids: [1, 2],
      active_company_id: 1,
    });
    expect(result.model).toBe('sale.order');
    expect(result.domain).toEqual([['state', '=', 'sale']]);
    expect(result.fields).toEqual(['name', 'partner_id']);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
    expect(result.order).toBe('name asc');
    expect(result.allowed_company_ids).toEqual([1, 2]);
    expect(result.active_company_id).toBe(1);
  });

  it('throws ZodError for negative limit', () => {
    expect(() => searchReadSchema.parse({ model: 'res.partner', limit: -1 })).toThrow(ZodError);
  });

  it('throws ZodError for negative offset', () => {
    expect(() => searchReadSchema.parse({ model: 'res.partner', offset: -1 })).toThrow(ZodError);
  });
});

describe('readSchema', () => {
  it('parses with defaults', () => {
    const result = readSchema.parse({ model: 'res.partner', ids: [1, 2] });
    expect(result.model).toBe('res.partner');
    expect(result.ids).toEqual([1, 2]);
    expect(result.fields).toEqual([]);
  });

  it('throws ZodError for empty ids array', () => {
    expect(() => readSchema.parse({ model: 'res.partner', ids: [] })).toThrow(ZodError);
  });

  it('throws ZodError for missing ids', () => {
    expect(() => readSchema.parse({ model: 'res.partner' })).toThrow(ZodError);
  });
});

describe('createSchema', () => {
  it('parses with a single record object', () => {
    const result = createSchema.parse({ model: 'res.partner', values: { name: 'Acme' } });
    expect(result.model).toBe('res.partner');
    expect(result.values).toEqual({ name: 'Acme' });
  });

  it('parses with an array of record objects', () => {
    const result = createSchema.parse({ model: 'res.partner', values: [{ name: 'A' }, { name: 'B' }] });
    expect(Array.isArray(result.values)).toBe(true);
  });

  it('throws ZodError for missing values', () => {
    expect(() => createSchema.parse({ model: 'res.partner' })).toThrow(ZodError);
  });
});

describe('writeSchema', () => {
  it('parses valid input', () => {
    const result = writeSchema.parse({ model: 'res.partner', ids: [1], values: { name: 'New Name' } });
    expect(result.ids).toEqual([1]);
    expect(result.values).toEqual({ name: 'New Name' });
  });

  it('throws ZodError for empty ids', () => {
    expect(() => writeSchema.parse({ model: 'res.partner', ids: [], values: {} })).toThrow(ZodError);
  });
});

describe('unlinkSchema', () => {
  it('parses valid input', () => {
    const result = unlinkSchema.parse({ model: 'res.partner', ids: [1, 2, 3] });
    expect(result.ids).toEqual([1, 2, 3]);
  });

  it('throws ZodError for empty ids', () => {
    expect(() => unlinkSchema.parse({ model: 'res.partner', ids: [] })).toThrow(ZodError);
  });
});

describe('searchCountSchema', () => {
  it('parses with default domain', () => {
    const result = searchCountSchema.parse({ model: 'res.partner' });
    expect(result.domain).toEqual([]);
  });

  it('parses with custom domain', () => {
    const result = searchCountSchema.parse({ model: 'res.partner', domain: [['active', '=', true]] });
    expect(result.domain).toEqual([['active', '=', true]]);
  });
});

describe('executeSchema', () => {
  it('AC-3: parses with default args and kwargs', () => {
    const result = executeSchema.parse({ model: 'res.partner', method: 'do_something' });
    expect(result.args).toEqual([]);
    expect(result.kwargs).toEqual({});
  });

  it('throws ZodError for empty method string', () => {
    expect(() => executeSchema.parse({ model: 'res.partner', method: '' })).toThrow(ZodError);
  });

  it('parses with custom args and kwargs', () => {
    const result = executeSchema.parse({ model: 'res.partner', method: 'action_confirm', args: [1, 2], kwargs: { context: {} } });
    expect(result.args).toEqual([1, 2]);
    expect(result.kwargs).toEqual({ context: {} });
  });
});

describe('runReportSchema', () => {
  it('parses with numeric report_id', () => {
    const result = runReportSchema.parse({ report_id: 42, doc_ids: [1, 2] });
    expect(result.report_id).toBe(42);
    expect(result.doc_ids).toEqual([1, 2]);
  });

  it('parses with string report_id', () => {
    const result = runReportSchema.parse({ report_id: 'account.report_invoice', doc_ids: [1] });
    expect(result.report_id).toBe('account.report_invoice');
  });

  it('throws ZodError for empty doc_ids', () => {
    expect(() => runReportSchema.parse({ report_id: 1, doc_ids: [] })).toThrow(ZodError);
  });

  it('throws ZodError for empty string report_id', () => {
    expect(() => runReportSchema.parse({ report_id: '', doc_ids: [1] })).toThrow(ZodError);
  });
});

describe('callActionSchema', () => {
  it('parses valid input', () => {
    const result = callActionSchema.parse({ model: 'sale.order', ids: [1], action_name: 'action_confirm' });
    expect(result.action_name).toBe('action_confirm');
    expect(result.context).toBeUndefined();
  });

  it('parses with optional context', () => {
    const result = callActionSchema.parse({ model: 'sale.order', ids: [1], action_name: 'action_confirm', context: { lang: 'en_US' } });
    expect(result.context).toEqual({ lang: 'en_US' });
  });
});

describe('fieldsGetSchema', () => {
  it('parses with no attributes', () => {
    const result = fieldsGetSchema.parse({ model: 'res.partner' });
    expect(result.model).toBe('res.partner');
    expect(result.attributes).toBeUndefined();
  });

  it('parses with attributes list', () => {
    const result = fieldsGetSchema.parse({ model: 'res.partner', attributes: ['string', 'type'] });
    expect(result.attributes).toEqual(['string', 'type']);
  });
});

describe('AC-4: all 10 schemas exported', () => {
  it('all schema exports are defined', () => {
    expect(searchReadSchema).toBeDefined();
    expect(readSchema).toBeDefined();
    expect(createSchema).toBeDefined();
    expect(writeSchema).toBeDefined();
    expect(unlinkSchema).toBeDefined();
    expect(searchCountSchema).toBeDefined();
    expect(executeSchema).toBeDefined();
    expect(runReportSchema).toBeDefined();
    expect(callActionSchema).toBeDefined();
    expect(fieldsGetSchema).toBeDefined();
  });
});
