import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OdooError,
  OdooAuthError,
  OdooUserError,
  OdooValidationError,
  OdooAccessError,
  OdooMissingError,
  OdooConnectionError,
} from '../src/errors.js';
import { jsonRpc } from '../src/rpc.js';

const BASE_URL = 'http://localhost:8069';
const ENDPOINT = '/web/dataset/call_kw';

function makeFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function makeOdooResponse(result: unknown) {
  return makeFetchResponse({ jsonrpc: '2.0', id: 1, result });
}

function makeOdooError(name: string, message: string, debug = 'traceback...') {
  return makeFetchResponse({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: 200,
      message: 'Odoo Server Error',
      data: { name, message, debug },
    },
  });
}

describe('jsonRpc', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Successful response returns result unwrapped
  it('returns response.result on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOdooResponse({ id: 42, name: 'Test' })));
    const result = await jsonRpc(BASE_URL, ENDPOINT, { model: 'res.partner', method: 'read' });
    expect(result).toEqual({ id: 42, name: 'Test' });
  });

  // 2. AccessError
  it('throws OdooAccessError for odoo.exceptions.AccessError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOdooError('odoo.exceptions.AccessError', 'You are not allowed to access this document')),
    );
    await expect(jsonRpc(BASE_URL, ENDPOINT, {})).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(OdooAccessError);
      expect((err as OdooError).message).toBe('You are not allowed to access this document');
      return true;
    });
  });

  // 3. UserError
  it('throws OdooUserError for odoo.exceptions.UserError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOdooError('odoo.exceptions.UserError', 'Name is required')),
    );
    await expect(jsonRpc(BASE_URL, ENDPOINT, {})).rejects.toBeInstanceOf(OdooUserError);
  });

  // 4. ValidationError
  it('throws OdooValidationError for odoo.exceptions.ValidationError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOdooError('odoo.exceptions.ValidationError', 'Invalid email format')),
    );
    await expect(jsonRpc(BASE_URL, ENDPOINT, {})).rejects.toBeInstanceOf(OdooValidationError);
  });

  // 5. MissingError
  it('throws OdooMissingError for odoo.exceptions.MissingError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOdooError('odoo.exceptions.MissingError', 'Record not found')),
    );
    await expect(jsonRpc(BASE_URL, ENDPOINT, {})).rejects.toBeInstanceOf(OdooMissingError);
  });

  // 6. AccessDenied → OdooAuthError
  it('throws OdooAuthError for odoo.exceptions.AccessDenied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOdooError('odoo.exceptions.AccessDenied', 'Invalid credentials')),
    );
    const err = await jsonRpc(BASE_URL, ENDPOINT, {}).catch((e) => e);
    expect(err).toBeInstanceOf(OdooAuthError);
    expect(err.message).toBe('Invalid credentials');
  });

  // 7. Timeout after 30 seconds
  it('throws OdooConnectionError with "timeout" after 30s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = opts?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }),
    );

    const promise = jsonRpc(BASE_URL, ENDPOINT, {});
    vi.advanceTimersByTime(30_001);

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(OdooConnectionError);
    expect(err.message).toMatch(/timeout/i);
  });

  // 8. Fetch rejection (DNS failure)
  it('throws OdooConnectionError wrapping DNS failure message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS failure')));
    const err = await jsonRpc(BASE_URL, ENDPOINT, {}).catch((e) => e);
    expect(err).toBeInstanceOf(OdooConnectionError);
    expect(err.message).toBe('DNS failure');
  });

  // 9. Unrecognized error name → OdooError with errorType 'ServerError'
  it('throws OdooError with errorType "ServerError" for unrecognized error name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeOdooError('odoo.custom.Error', 'Something went wrong')),
    );
    const err = await jsonRpc(BASE_URL, ENDPOINT, {}).catch((e) => e);
    expect(err).toBeInstanceOf(OdooError);
    expect(err.errorType).toBe('ServerError');
    expect(err.message).toBe('Something went wrong');
  });

  // 10. Verify request body shape
  it('POSTs to the correct URL with JSON-RPC envelope and Content-Type header', async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeOdooResponse(null));
    vi.stubGlobal('fetch', mockFetch);

    await jsonRpc(BASE_URL, ENDPOINT, { model: 'res.partner', method: 'read' }, { 'X-Custom': 'header' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${BASE_URL}${ENDPOINT}`);
    expect((calledInit.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((calledInit.headers as Record<string, string>)['X-Custom']).toBe('header');

    const parsedBody = JSON.parse(calledInit.body as string) as {
      jsonrpc: string;
      method: string;
      id: number;
      params: Record<string, unknown>;
    };
    expect(parsedBody.jsonrpc).toBe('2.0');
    expect(parsedBody.method).toBe('call');
    expect(typeof parsedBody.id).toBe('number');
    expect(parsedBody.params).toEqual({ model: 'res.partner', method: 'read' });
  });
});
