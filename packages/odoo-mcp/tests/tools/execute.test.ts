import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OdooSession } from '@netlinksinc/odoo-client';
import { OdooError, OdooUserError } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';
import type { Logger } from '../../src/logger.js';
import type { ClientResolver } from '../../src/types.js';
import { registerExecuteTool } from '../../src/tools/execute.js';

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

function makeClientMock() {
  return {
    execute: vi.fn().mockResolvedValue({ ok: true }),
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
  registerExecuteTool(serverMock as never, mockResolver, loggerMock);
});

// ---------------------------------------------------------------------------
// AC-1: Valid call passes through to client.execute and returns result
// ---------------------------------------------------------------------------

describe('AC-1: valid call routes to client.execute', () => {
  it('calls client.execute with model, method, args, kwargs, context and returns result', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      method: 'write',
      args: [],
      kwargs: {},
    });

    expect(clientMock.execute).toHaveBeenCalledOnce();
    const [model, method, args, kwargs, context] = (clientMock.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(model).toBe('res.partner');
    expect(method).toBe('write');
    expect(args).toEqual([]);
    expect(kwargs).toEqual({});
    expect(context).toMatchObject({ uid: 1, company_id: 1, allowed_company_ids: [1] });

    expect(response).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    });
  });

  it('logs toolCall with status ok on success', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner', method: 'write', args: [], kwargs: {} });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_execute', status: 'ok' }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2: model with uppercase returns InputValidationError, no client call
// ---------------------------------------------------------------------------

describe('AC-2: uppercase model rejected', () => {
  it('returns isError:true with InputValidationError for Res.Partner', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'Res.Partner',
      method: 'write',
      args: [],
      kwargs: {},
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(payload.message).toContain('model must match');
  });

  it('does NOT call client.execute for invalid model', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'Res.Partner', method: 'write', args: [], kwargs: {} });
    expect(clientMock.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-4: OdooUserError from client is surfaced as isError:true with UserError
// ---------------------------------------------------------------------------

describe('AC-4: OdooUserError mapped to isError:true', () => {
  it('returns isError:true with error_type UserError when client throws OdooUserError', async () => {
    (clientMock.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooUserError('boom'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      method: 'write',
      args: [],
      kwargs: {},
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('UserError');
    expect(payload.message).toBe('boom');
  });
});

// ---------------------------------------------------------------------------
// Additional tests: Zod parse failure and company subset validation
// ---------------------------------------------------------------------------

describe('Zod parse failure', () => {
  it('returns isError:true when model is missing', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({ method: 'write' }) as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });
});

describe('company subset validation', () => {
  it('returns isError:true when allowed_company_ids not in session', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      method: 'write',
      args: [],
      kwargs: {},
      allowed_company_ids: [999],
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(clientMock.execute).not.toHaveBeenCalled();
  });
});

describe('server.registerTool registration', () => {
  it('registers exactly one tool named odoo_execute', () => {
    expect(serverMock.registerTool).toHaveBeenCalledWith(
      'odoo_execute',
      expect.any(Object),
      expect.any(Function),
    );
    expect(serverMock.registerTool).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// F-005: non-OdooError caught + logged + returns isError with InternalError
// ---------------------------------------------------------------------------

describe('non-OdooError caught and returned as InternalError (F-005)', () => {
  it('catches TypeError from client.execute and returns isError:true with error_type InternalError', async () => {
    (clientMock.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError('network failure'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      method: 'write',
      args: [],
      kwargs: {},
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InternalError');
    expect(payload.message).toBe('unexpected error');
    expect(payload.detail).toBe('network failure');
  });
});

// ---------------------------------------------------------------------------
// ClientResolver: error propagates out of handler
// ---------------------------------------------------------------------------

describe('ClientResolver error propagation', () => {
  it('propagates rejection from clientResolver without catching', async () => {
    const authError = new Error('OdooAuthError: session expired');
    const failingResolver: ClientResolver = async () => {
      throw authError;
    };
    const failServerMock = makeServerMock();
    registerExecuteTool(failServerMock as never, failingResolver, loggerMock);

    await expect(
      failServerMock.getHandler()({ model: 'res.partner', method: 'write', args: [], kwargs: {} }),
    ).rejects.toThrow('OdooAuthError: session expired');
  });
});
