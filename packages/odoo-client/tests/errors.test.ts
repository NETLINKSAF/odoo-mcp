import { describe, it, expect } from 'vitest';
import {
  OdooError,
  OdooAuthError,
  OdooUserError,
  OdooValidationError,
  OdooAccessError,
  OdooMissingError,
  OdooConnectionError,
} from '../src/errors.js';

describe('OdooError (base class)', () => {
  it('sets all properties correctly', () => {
    const err = new OdooError('CustomType', 'Something broke', 'res.partner', 'write', 'Traceback...');
    expect(err.errorType).toBe('CustomType');
    expect(err.message).toBe('Something broke');
    expect(err.model).toBe('res.partner');
    expect(err.method).toBe('write');
    expect(err.traceback).toBe('Traceback...');
    expect(err.name).toBe('OdooError');
    expect(err instanceof Error).toBe(true);
  });
});

describe('OdooAuthError', () => {
  it('sets errorType, message, and traceback; model and method are undefined', () => {
    const err = new OdooAuthError('Invalid credentials', 'Traceback auth...');
    expect(err.errorType).toBe('OdooAuthError');
    expect(err.message).toBe('Invalid credentials');
    expect(err.traceback).toBe('Traceback auth...');
    expect(err.model).toBeUndefined();
    expect(err.method).toBeUndefined();
    expect(err.name).toBe('OdooAuthError');
    expect(err instanceof OdooError).toBe(true);
  });

  it('works without traceback', () => {
    const err = new OdooAuthError('No session');
    expect(err.traceback).toBeUndefined();
  });
});

describe('OdooUserError', () => {
  it('sets all properties from constructor args', () => {
    const err = new OdooUserError('Name is required', 'res.partner', 'create', 'Traceback user...');
    expect(err.errorType).toBe('UserError');
    expect(err.message).toBe('Name is required');
    expect(err.model).toBe('res.partner');
    expect(err.method).toBe('create');
    expect(err.traceback).toBe('Traceback user...');
    expect(err.name).toBe('OdooUserError');
    expect(err instanceof OdooError).toBe(true);
  });
});

describe('OdooValidationError', () => {
  it('sets all properties from constructor args', () => {
    const err = new OdooValidationError('Invalid email', 'res.partner', 'write', 'Traceback val...');
    expect(err.errorType).toBe('ValidationError');
    expect(err.message).toBe('Invalid email');
    expect(err.model).toBe('res.partner');
    expect(err.method).toBe('write');
    expect(err.traceback).toBe('Traceback val...');
    expect(err.name).toBe('OdooValidationError');
    expect(err instanceof OdooError).toBe(true);
  });
});

describe('OdooAccessError', () => {
  it('sets all properties from constructor args', () => {
    const err = new OdooAccessError('Access denied', 'account.move', 'read', 'Traceback access...');
    expect(err.errorType).toBe('AccessError');
    expect(err.message).toBe('Access denied');
    expect(err.model).toBe('account.move');
    expect(err.method).toBe('read');
    expect(err.traceback).toBe('Traceback access...');
    expect(err.name).toBe('OdooAccessError');
    expect(err instanceof OdooError).toBe(true);
  });
});

describe('OdooMissingError', () => {
  it('sets all properties from constructor args', () => {
    const err = new OdooMissingError('Record not found', 'res.users', 'unlink', 'Traceback missing...');
    expect(err.errorType).toBe('MissingError');
    expect(err.message).toBe('Record not found');
    expect(err.model).toBe('res.users');
    expect(err.method).toBe('unlink');
    expect(err.traceback).toBe('Traceback missing...');
    expect(err.name).toBe('OdooMissingError');
    expect(err instanceof OdooError).toBe(true);
  });
});

describe('OdooConnectionError', () => {
  it('sets errorType and message; model, method, and traceback are undefined', () => {
    const err = new OdooConnectionError('Network timeout');
    expect(err.errorType).toBe('ConnectionError');
    expect(err.message).toBe('Network timeout');
    expect(err.model).toBeUndefined();
    expect(err.method).toBeUndefined();
    expect(err.traceback).toBeUndefined();
    expect(err.name).toBe('OdooConnectionError');
    expect(err instanceof OdooError).toBe(true);
  });

  it('is instanceof Error', () => {
    const err = new OdooConnectionError('Connection refused');
    expect(err instanceof Error).toBe(true);
  });
});

// TypeScript-level note: the following call would produce a compile error because
// OdooConnectionError accepts only `message: string` — no second argument.
//
//   new OdooConnectionError('msg', 'res.partner')
//              TS Error: Expected 1 arguments, but got 2.
