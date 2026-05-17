import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OdooSession } from '@netlinksinc/odoo-client';
import { OdooError, OdooMissingError } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';
import type { Logger } from '../../src/logger.js';
import type { ClientResolver } from '../../src/types.js';
import { registerIntrospectTool } from '../../src/tools/introspect.js';

// ---------------------------------------------------------------------------
// Mock http-transport to prevent side-effects during tests
// ---------------------------------------------------------------------------

vi.mock('../../src/http-transport.js', () => ({
  requestContextStorage: {
    getStore: () => undefined,
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SESSION: OdooSession = {
  uid: 1,
  companyId: 1,
  allowedCompanyIds: [1],
  userContext: {},
};

const FIELDS_RESULT = {
  name: { string: 'Name', type: 'char', required: true },
  email: { string: 'Email', type: 'char', required: false },
};

function makeClientMock() {
  return {
    fieldsGet: vi.fn().mockResolvedValue(FIELDS_RESULT),
  } as unknown as OdooClient;
}

function makeLoggerMock(): Logger {
  return {
    toolCall: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helper: capture the handler registered by server.registerTool()
// ---------------------------------------------------------------------------

function makeServerMock() {
  let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  const server = {
    registerTool: vi.fn(
      (
        name: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ) => {
        capturedHandler = handler;
      },
    ),
    getHandler: () => {
      if (!capturedHandler) throw new Error('Handler not registered');
      return capturedHandler;
    },
  };
  return server;
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let serverMock: ReturnType<typeof makeServerMock>;
let clientMock: OdooClient;
let loggerMock: Logger;
let mockResolver: ClientResolver;

beforeEach(() => {
  serverMock = makeServerMock();
  clientMock = makeClientMock();
  loggerMock = makeLoggerMock();
  mockResolver = async () => ({ client: clientMock, session: SESSION });
  registerIntrospectTool(serverMock as never, mockResolver, loggerMock);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('server.registerTool registration', () => {
  it('registers exactly one tool named odoo_fields_get', () => {
    expect(serverMock.registerTool).toHaveBeenCalledWith(
      'odoo_fields_get',
      expect.any(Object),
      expect.any(Function),
    );
    expect(serverMock.registerTool).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// AC-1: No attributes → calls client.fieldsGet with undefined
// ---------------------------------------------------------------------------

describe('AC-1: no attributes passes undefined to client.fieldsGet', () => {
  it('calls client.fieldsGet with undefined attributes when not provided', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({ model: 'res.partner' });

    expect(clientMock.fieldsGet).toHaveBeenCalledOnce();
    const [model, attributes, context] = (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(model).toBe('res.partner');
    expect(attributes).toBeUndefined();
    expect(context).toMatchObject({ uid: 1, company_id: 1, allowed_company_ids: [1] });

    expect(response).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(FIELDS_RESULT) }],
    });
  });

  it('logs toolCall with status ok on success', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner' });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_fields_get', status: 'ok' }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2: With attributes → passes array to client.fieldsGet
// ---------------------------------------------------------------------------

describe('AC-2: with attributes passes array to client.fieldsGet', () => {
  it('calls client.fieldsGet with the given attributes array', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({ model: 'res.partner', attributes: ['string', 'type'] });

    expect(clientMock.fieldsGet).toHaveBeenCalledOnce();
    const [model, attributes] = (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(model).toBe('res.partner');
    expect(attributes).toEqual(['string', 'type']);

    expect(response).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(FIELDS_RESULT) }],
    });
  });
});

// ---------------------------------------------------------------------------
// AC-3: client.fieldsGet throws OdooMissingError → isError:true with details
// ---------------------------------------------------------------------------

describe('AC-3: client.fieldsGet throwing OdooMissingError returns isError:true', () => {
  it('returns isError:true with error_type MissingError when model not found', async () => {
    (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooMissingError('Model not_a_model not found'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({ model: 'not_a_model' }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('MissingError');
    expect(payload.message).toContain('not_a_model');
  });

  it('logs toolCall with status error on OdooMissingError', async () => {
    (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooMissingError('Model not_a_model not found'),
    );
    const handler = serverMock.getHandler();
    await handler({ model: 'not_a_model' });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_fields_get', status: 'error' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Zod parse failure
// ---------------------------------------------------------------------------

describe('Zod parse failure', () => {
  it('returns isError:true with InputValidationError when model is missing', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({}) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(clientMock.fieldsGet).not.toHaveBeenCalled();
  });

  it('logs toolCall with status error and InputValidationError on Zod failure (F-004)', async () => {
    const handler = serverMock.getHandler();
    await handler({});
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_fields_get', status: 'error', error: 'InputValidationError' }),
    );
  });

  it('uppercase model → isError:true with InputValidationError (model regex)', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({ model: 'Res.Partner' }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(payload.message).toContain('model must match');
  });
});

// ---------------------------------------------------------------------------
// Company subset validation
// ---------------------------------------------------------------------------

describe('company subset validation', () => {
  it('returns isError:true when allowed_company_ids not in session', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      allowed_company_ids: [999],
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(clientMock.fieldsGet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F-005: non-OdooError caught + logged + returns isError with InternalError
// ---------------------------------------------------------------------------

describe('non-OdooError caught and returned as InternalError (F-005)', () => {
  it('catches TypeError from client.fieldsGet and returns isError:true with InternalError', async () => {
    const networkError = new TypeError('fetch failed');
    (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(networkError);
    const handler = serverMock.getHandler();
    const response = await handler({ model: 'res.partner' }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InternalError');
    expect(payload.message).toBe('An internal error occurred');
    expect(payload.detail).toBeUndefined();
  });

  it('logs toolCall with status error and InternalError on non-OdooError (F-005)', async () => {
    const networkError = new TypeError('fetch failed');
    (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(networkError);
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner' });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_fields_get', status: 'error', error: 'InternalError' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Generic OdooError (not a subclass) is also caught
// ---------------------------------------------------------------------------

describe('generic OdooError handling', () => {
  it('catches base OdooError and returns isError:true', async () => {
    (clientMock.fieldsGet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooError('AccessError', 'Access denied'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({ model: 'res.partner' }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('AccessError');
  });
});

// ---------------------------------------------------------------------------
// ClientResolver error propagation
// ---------------------------------------------------------------------------

describe('ClientResolver error propagation', () => {
  it('propagates rejection from clientResolver without catching', async () => {
    const authError = new Error('OdooAuthError: session expired');
    const failingResolver: ClientResolver = async () => {
      throw authError;
    };
    const failServerMock = makeServerMock();
    registerIntrospectTool(failServerMock as never, failingResolver, loggerMock);

    await expect(
      failServerMock.getHandler()({ model: 'res.partner' }),
    ).rejects.toThrow('OdooAuthError: session expired');
  });
});
