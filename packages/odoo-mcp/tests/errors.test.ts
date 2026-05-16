import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  OdooAuthError,
  OdooUserError,
  OdooValidationError,
  OdooAccessError,
  OdooMissingError,
  OdooConnectionError,
} from '@netlinksinc/odoo-client';
import { formatMcpError } from '../src/errors.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('formatMcpError — error_type and message mapping', () => {
  it('OdooAuthError: maps errorType and message verbatim', () => {
    const err = new OdooAuthError('invalid credentials');
    const result = formatMcpError(err);
    expect(result.error_type).toBe('OdooAuthError');
    expect(result.message).toBe('invalid credentials');
    expect(result.message).toBe(err.message);
  });

  it('OdooUserError: maps errorType and message verbatim', () => {
    const err = new OdooUserError('bad input', 'res.partner', 'write');
    const result = formatMcpError(err);
    expect(result.error_type).toBe('UserError');
    expect(result.message).toBe('bad input');
    expect(result.message).toBe(err.message);
    expect(result.model).toBe('res.partner');
    expect(result.method).toBe('write');
  });

  it('OdooValidationError: maps errorType and message verbatim', () => {
    const err = new OdooValidationError('field required', 'res.partner', 'create');
    const result = formatMcpError(err);
    expect(result.error_type).toBe('ValidationError');
    expect(result.message).toBe('field required');
    expect(result.message).toBe(err.message);
    expect(result.model).toBe('res.partner');
    expect(result.method).toBe('create');
  });

  it('OdooAccessError: maps errorType and message verbatim', () => {
    const err = new OdooAccessError('access denied', 'account.move', 'unlink');
    const result = formatMcpError(err);
    expect(result.error_type).toBe('AccessError');
    expect(result.message).toBe('access denied');
    expect(result.message).toBe(err.message);
  });

  it('OdooMissingError: maps errorType and message verbatim', () => {
    const err = new OdooMissingError('record not found', 'product.template', 'read');
    const result = formatMcpError(err);
    expect(result.error_type).toBe('MissingError');
    expect(result.message).toBe('record not found');
    expect(result.message).toBe(err.message);
  });

  it('OdooConnectionError: maps errorType and message verbatim', () => {
    const err = new OdooConnectionError('connection refused');
    const result = formatMcpError(err);
    expect(result.error_type).toBe('ConnectionError');
    expect(result.message).toBe('connection refused');
    expect(result.message).toBe(err.message);
  });
});

describe('formatMcpError — traceback omission (debug off)', () => {
  it('OdooUserError with traceback: traceback key ABSENT when ODOO_MCP_DEBUG is unset', () => {
    vi.unstubAllEnvs(); // ensure clean
    const err = new OdooUserError('bad input', 'res.partner', 'write', 'tb-text');
    const result = formatMcpError(err);
    expect('traceback' in result).toBe(false);
  });

  it('OdooUserError with traceback: traceback key ABSENT when ODOO_MCP_DEBUG=0', () => {
    vi.stubEnv('ODOO_MCP_DEBUG', '0');
    const err = new OdooUserError('bad input', 'res.partner', 'write', 'tb-text');
    const result = formatMcpError(err);
    expect('traceback' in result).toBe(false);
  });
});

describe('formatMcpError — traceback inclusion (debug on)', () => {
  it('OdooUserError with traceback: traceback included when ODOO_MCP_DEBUG=1', () => {
    vi.stubEnv('ODOO_MCP_DEBUG', '1');
    const err = new OdooUserError('bad input', 'res.partner', 'write', 'tb-text');
    const result = formatMcpError(err);
    expect(result.traceback).toBe('tb-text');
    expect('traceback' in result).toBe(true);
  });

  it('OdooAuthError with traceback: traceback included when ODOO_MCP_DEBUG=1', () => {
    vi.stubEnv('ODOO_MCP_DEBUG', '1');
    const err = new OdooAuthError('bad creds', 'trace-auth');
    const result = formatMcpError(err);
    expect(result.traceback).toBe('trace-auth');
  });

  it('OdooConnectionError: no traceback key even in debug mode (constructor does not accept it)', () => {
    vi.stubEnv('ODOO_MCP_DEBUG', '1');
    const err = new OdooConnectionError('refused');
    const result = formatMcpError(err);
    expect('traceback' in result).toBe(false);
  });
});

describe('formatMcpError — optional fields absent when not provided', () => {
  it('model and method absent when not provided', () => {
    const err = new OdooAuthError('bad auth');
    const result = formatMcpError(err);
    expect('model' in result).toBe(false);
    expect('method' in result).toBe(false);
  });
});
