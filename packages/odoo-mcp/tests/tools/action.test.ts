import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OdooSession } from '@netlinksinc/odoo-client';
import { OdooError, OdooUserError, OdooAccessError } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';
import type { Logger } from '../../src/logger.js';
import type { ClientResolver } from '../../src/types.js';
import { registerActionTool } from '../../src/tools/action.js';

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
  userContext: { lang: 'en_US' },
};

function makeClientMock() {
  return {
    callAction: vi.fn().mockResolvedValue({ type: 'ir.actions.act_window', name: 'Partners' }),
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
  registerActionTool(serverMock as never, mockResolver, loggerMock);
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('server.registerTool registration', () => {
  it('registers exactly one tool named odoo_call_action', () => {
    expect(serverMock.registerTool).toHaveBeenCalledWith(
      'odoo_call_action',
      expect.any(Object),
      expect.any(Function),
    );
    expect(serverMock.registerTool).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// AC-1: context passthrough + uid/company_id identity protection
// ---------------------------------------------------------------------------

describe('AC-1: caller context passes through but uid/company_id are session-derived', () => {
  it('passes active_test:false through to client.callAction context', async () => {
    const handler = serverMock.getHandler();
    await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
      context: { active_test: false },
    });

    expect(clientMock.callAction).toHaveBeenCalledOnce();
    const context = (clientMock.callAction as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    expect(context.active_test).toBe(false);
    expect(context.uid).toBe(1);
    expect(context.company_id).toBe(1);
  });

  it('caller-supplied uid is overridden by session uid (cannot override identity)', async () => {
    const handler = serverMock.getHandler();
    await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
      context: { uid: 999 },
    });

    const context = (clientMock.callAction as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    // uid must be session-derived (1), not caller-supplied (999)
    expect(context.uid).toBe(1);
    expect(context.company_id).toBe(1);
  });

  it('lang from session userContext is preserved in merged context', async () => {
    const handler = serverMock.getHandler();
    await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
    });

    const context = (clientMock.callAction as ReturnType<typeof vi.fn>).mock.calls[0][3] as Record<string, unknown>;
    expect(context.lang).toBe('en_US');
    expect(context.uid).toBe(1);
    expect(context.allowed_company_ids).toEqual([1]);
  });

  it('returns isError:false with JSON-stringified result on success', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(false);
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed).toMatchObject({ type: 'ir.actions.act_window', name: 'Partners' });
  });
});

// ---------------------------------------------------------------------------
// AC-2: client.callAction throwing → isError:true with Odoo fault message
// ---------------------------------------------------------------------------

describe('AC-2: client.callAction throwing returns isError:true', () => {
  it('OdooUserError → isError:true with verbatim fault message', async () => {
    (clientMock.callAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooUserError('action not found on model'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'missing_action',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.message).toBe('action not found on model');
    expect(payload.error_type).toBe('UserError');
  });

  it('OdooAccessError → isError:true with AccessError type', async () => {
    (clientMock.callAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooAccessError('access denied'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('AccessError');
    expect(payload.message).toBe('access denied');
  });

  it('does NOT call client.callAction when Zod parse fails', async () => {
    const handler = serverMock.getHandler();
    // Missing required fields: ids, action_name
    await handler({ model: 'res.partner' });
    expect(clientMock.callAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('Input validation', () => {
  it('missing model → isError:true with InputValidationError', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      ids: [1],
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });

  it('missing ids → isError:true with InputValidationError', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });

  it('empty ids array → isError:true (min(1) constraint)', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [],
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });

  it('uppercase model → isError:true with InputValidationError (model regex)', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'Res.Partner',
      ids: [1],
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(payload.message).toContain('model must match');
  });

  it('invalid action_name → isError:true with InputValidationError (method regex)', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'My-Action',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(payload.message).toContain('method must match');
  });
});

// ---------------------------------------------------------------------------
// Company subset validation
// ---------------------------------------------------------------------------

describe('Company subset validation', () => {
  it('allowed_company_ids not in session → isError:true, no client call', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
      allowed_company_ids: [999],
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    expect(clientMock.callAction).not.toHaveBeenCalled();
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
  });

  it('valid allowed_company_ids → client is called with scoped context', async () => {
    const sessionMulti: OdooSession = {
      uid: 1,
      companyId: 1,
      allowedCompanyIds: [1, 2],
      userContext: { lang: 'en_US' },
    };

    let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
    const mockServer = {
      registerTool: vi.fn(
        (_name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
          capturedHandler = handler;
        },
      ),
    };
    const mockClient = {
      callAction: vi.fn().mockResolvedValue({ type: 'ir.actions.act_window' }),
    };
    const mockLogger = { toolCall: vi.fn(), startup: vi.fn(), shutdown: vi.fn() };
    const multiResolver: ClientResolver = async () => ({
      client: mockClient as never,
      session: sessionMulti,
    });

    registerActionTool(mockServer as never, multiResolver, mockLogger);
    const result = await capturedHandler!({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
      allowed_company_ids: [2],
    }) as { isError: boolean };

    expect(result.isError).toBe(false);
    expect(mockClient.callAction).toHaveBeenCalled();
    const context = mockClient.callAction.mock.calls[0][3] as Record<string, unknown>;
    expect(context.allowed_company_ids).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('Logging', () => {
  it('logs status:ok on success', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner', ids: [1], action_name: 'action_open_partners' });

    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_call_action', status: 'ok' }),
    );
  });

  it('logs status:error on OdooError', async () => {
    (clientMock.callAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooUserError('boom'),
    );
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner', ids: [1], action_name: 'action_open_partners' });

    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_call_action', status: 'error' }),
    );
  });

  it('logs status:error with InputValidationError on Zod failure (F-004)', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner' }); // missing ids and action_name

    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_call_action', status: 'error', error: 'InputValidationError' }),
    );
  });
});

// ---------------------------------------------------------------------------
// F-005: non-OdooError caught + logged + returns isError with InternalError
// ---------------------------------------------------------------------------

describe('non-OdooError caught and returned as InternalError (F-005)', () => {
  it('catches plain Error from client.callAction and returns isError:true with InternalError', async () => {
    (clientMock.callAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network failure'),
    );
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      ids: [1],
      action_name: 'action_open_partners',
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InternalError');
    expect(payload.message).toBe('unexpected error');
    expect(payload.detail).toBe('network failure');
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
    registerActionTool(failServerMock as never, failingResolver, loggerMock);

    await expect(
      failServerMock.getHandler()({
        model: 'res.partner',
        ids: [1],
        action_name: 'action_open_partners',
      }),
    ).rejects.toThrow('OdooAuthError: session expired');
  });
});
