import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OdooSession } from '@netlinks/odoo-client';
import { OdooError, OdooUserError } from '@netlinks/odoo-client';
import type { OdooClient } from '@netlinks/odoo-client';
import type { Logger } from '../../src/logger.js';
import { registerExecuteTool } from '../../src/tools/execute.js';

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
// Helper: capture the handler registered by server.tool()
// ---------------------------------------------------------------------------

function makeServerMock() {
  let capturedHandler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  const server = {
    tool: vi.fn((name: string, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
      capturedHandler = handler;
    }),
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

beforeEach(() => {
  serverMock = makeServerMock();
  clientMock = makeClientMock();
  loggerMock = makeLoggerMock();
  registerExecuteTool(serverMock as never, clientMock, SESSION, loggerMock);
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
    expect(payload.message).toBe('model or method contains invalid characters');
  });

  it('does NOT call client.execute for invalid model', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'Res.Partner', method: 'write', args: [], kwargs: {} });
    expect(clientMock.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-3: method with invalid characters returns InputValidationError
// ---------------------------------------------------------------------------

describe('AC-3: method with invalid characters rejected', () => {
  it('returns isError:true with InputValidationError for My-Method', async () => {
    const handler = serverMock.getHandler();
    const response = await handler({
      model: 'res.partner',
      method: 'My-Method',
      args: [],
      kwargs: {},
    }) as { isError: boolean; content: Array<{ type: string; text: string }> };

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.error_type).toBe('InputValidationError');
    expect(payload.message).toBe('model or method contains invalid characters');
  });

  it('does NOT call client.execute for invalid method', async () => {
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner', method: 'My-Method', args: [], kwargs: {} });
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

  it('logs toolCall with status error on OdooError', async () => {
    (clientMock.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OdooUserError('boom'),
    );
    const handler = serverMock.getHandler();
    await handler({ model: 'res.partner', method: 'write', args: [], kwargs: {} });
    expect(loggerMock.toolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'odoo_execute', status: 'error' }),
    );
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

describe('server.tool registration', () => {
  it('registers exactly one tool named odoo_execute', () => {
    expect(serverMock.tool).toHaveBeenCalledWith('odoo_execute', expect.any(Function));
    expect(serverMock.tool).toHaveBeenCalledOnce();
  });
});
