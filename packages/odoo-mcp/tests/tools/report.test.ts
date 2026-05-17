import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OdooUserError, OdooAccessError, OdooError } from '@netlinksinc/odoo-client';
import type { OdooSession } from '@netlinksinc/odoo-client';
import type { ClientResolver } from '../../src/types.js';
import { registerReportTool } from '../../src/tools/report.js';

// ---------------------------------------------------------------------------
// Mock http-transport to prevent side-effects during tests
// ---------------------------------------------------------------------------

vi.mock('../../src/http-transport.js', () => ({
  requestContextStorage: {
    getStore: () => undefined,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION: OdooSession = {
  uid: 1,
  companyId: 1,
  allowedCompanyIds: [1],
  userContext: {},
};

// ---------------------------------------------------------------------------
// Helpers to build mocks
// ---------------------------------------------------------------------------

function buildMocks(session: OdooSession = SESSION) {
  // Capture the handler registered with server.registerTool
  let capturedHandler: ((args: unknown) => Promise<unknown>) | null = null;

  const mockServer = {
    registerTool: vi.fn((_name: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => {
      capturedHandler = handler;
    }),
  };

  const mockClient = {
    runReport: vi.fn().mockResolvedValue({
      content: 'JVBERi0xLjQ=', // base64 stub
      contentType: 'application/pdf',
    }),
  };

  const mockLogger = {
    toolCall: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  };

  const mockResolver: ClientResolver = async () => ({ client: mockClient as never, session });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerReportTool(mockServer as any, mockResolver, mockLogger);

  const callHandler = (args: unknown) => {
    if (!capturedHandler) throw new Error('Handler not registered');
    return capturedHandler(args);
  };

  return { mockServer, mockClient, mockLogger, mockResolver, callHandler };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerReportTool', () => {
  it('registers the tool named odoo_run_report', () => {
    const { mockServer } = buildMocks();
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'odoo_run_report',
      expect.any(Object),
      expect.any(Function),
    );
  });
});

describe('odoo_run_report handler', () => {
  describe('AC-1: valid args → calls client.runReport and returns content+contentType', () => {
    it('calls client.runReport with correct positional args', async () => {
      const { mockClient, callHandler } = buildMocks();

      await callHandler({ report_id: 1, doc_ids: [42] });

      expect(mockClient.runReport).toHaveBeenCalledOnce();
      const [reportId, docIds] = mockClient.runReport.mock.calls[0] as [number, number[], unknown];
      expect(reportId).toBe(1);
      expect(docIds).toEqual([42]);
    });

    it('returns isError:false with JSON { content, contentType } in text field', async () => {
      const { callHandler } = buildMocks();

      const result = await callHandler({ report_id: 1, doc_ids: [42] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('content');
      expect(parsed).toHaveProperty('contentType');
    });

    it('passes context built from session to client.runReport', async () => {
      const { mockClient, callHandler } = buildMocks();

      await callHandler({ report_id: 1, doc_ids: [42] });

      const context = mockClient.runReport.mock.calls[0][2] as Record<string, unknown>;
      expect(context.uid).toBe(SESSION.uid);
      expect(context.allowed_company_ids).toEqual(SESSION.allowedCompanyIds);
    });
  });

  describe('AC-2: OdooUserError → isError:true with verbatim message', () => {
    it('returns isError:true when client.runReport throws OdooUserError', async () => {
      const { mockClient, callHandler } = buildMocks();
      mockClient.runReport.mockRejectedValueOnce(new OdooUserError('Report not found'));

      const result = await callHandler({ report_id: 999, doc_ids: [1] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
    });

    it('carries verbatim Odoo error message in text field (AC-2)', async () => {
      const { mockClient, callHandler } = buildMocks();
      mockClient.runReport.mockRejectedValueOnce(new OdooUserError('Report not found'));

      const result = await callHandler({ report_id: 999, doc_ids: [1] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.message).toBe('Report not found');
    });
  });

  describe('Input validation', () => {
    it('missing report_id → isError:true with InputValidationError', async () => {
      const { callHandler } = buildMocks();

      const result = await callHandler({ doc_ids: [1] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error_type).toBe('InputValidationError');
    });

    it('empty doc_ids → isError:true with InputValidationError, no client call', async () => {
      const { mockClient, callHandler } = buildMocks();

      const result = await callHandler({ report_id: 1, doc_ids: [] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(mockClient.runReport).not.toHaveBeenCalled();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error_type).toBe('InputValidationError');
    });

    it('logs status:error with InputValidationError on Zod failure (F-004)', async () => {
      const { mockLogger, callHandler } = buildMocks();

      await callHandler({ doc_ids: [1] }); // missing report_id

      expect(mockLogger.toolCall).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'odoo_run_report', status: 'error', error: 'InputValidationError' }),
      );
    });
  });

  describe('Company subset validation', () => {
    it('allowed_company_ids outside session → isError:true without calling client', async () => {
      const { mockClient, callHandler } = buildMocks();

      const result = await callHandler({
        report_id: 1,
        doc_ids: [1],
        allowed_company_ids: [999],
      }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      expect(mockClient.runReport).not.toHaveBeenCalled();
    });

    it('valid allowed_company_ids → client is called with scoped context', async () => {
      const sessionMulti: OdooSession = {
        uid: 1,
        companyId: 1,
        allowedCompanyIds: [1, 2],
        userContext: {},
      };

      const { mockClient, callHandler } = buildMocks(sessionMulti);
      const result = await callHandler({ report_id: 1, doc_ids: [1], allowed_company_ids: [2] }) as {
        isError: boolean;
      };

      expect(result.isError).toBe(false);
      expect(mockClient.runReport).toHaveBeenCalled();
    });
  });

  describe('Logging', () => {
    it('logs status:ok on success', async () => {
      const { mockLogger, callHandler } = buildMocks();

      await callHandler({ report_id: 1, doc_ids: [42] });

      expect(mockLogger.toolCall).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'odoo_run_report', status: 'ok' }),
      );
    });

    it('logs status:error on OdooError', async () => {
      const { mockClient, mockLogger, callHandler } = buildMocks();
      mockClient.runReport.mockRejectedValueOnce(new OdooAccessError('access denied'));

      await callHandler({ report_id: 1, doc_ids: [1] });

      expect(mockLogger.toolCall).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'odoo_run_report', status: 'error' }),
      );
    });
  });

  describe('OdooError subclass forwarding', () => {
    it('OdooAccessError → isError:true with error_type:AccessError', async () => {
      const { mockClient, callHandler } = buildMocks();
      mockClient.runReport.mockRejectedValueOnce(new OdooAccessError('access denied'));

      const result = await callHandler({ report_id: 1, doc_ids: [1] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error_type).toBe('AccessError');
    });
  });

  describe('String report_id', () => {
    it('string report_id is accepted and passed through to client', async () => {
      const { mockClient, callHandler } = buildMocks();

      const result = await callHandler({ report_id: 'account.report_invoice', doc_ids: [1] }) as {
        isError: boolean;
      };

      expect(result.isError).toBe(false);
      const [reportId] = mockClient.runReport.mock.calls[0] as [string, number[], unknown];
      expect(reportId).toBe('account.report_invoice');
    });
  });

  describe('F-005: non-OdooError caught and returned as InternalError', () => {
    it('catches TypeError from client.runReport and returns isError:true with InternalError', async () => {
      const { mockClient, callHandler } = buildMocks();
      mockClient.runReport.mockRejectedValueOnce(new TypeError('connection reset'));

      const result = await callHandler({ report_id: 1, doc_ids: [1] }) as {
        isError: boolean;
        content: Array<{ type: string; text: string }>;
      };

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error_type).toBe('InternalError');
      expect(parsed.message).toBe('An internal error occurred');
      expect(parsed.detail).toBeUndefined();
    });
  });

  describe('ClientResolver error propagation', () => {
    it('propagates rejection from clientResolver without catching', async () => {
      const authError = new Error('OdooAuthError: session expired');
      let capturedHandler: ((args: unknown) => Promise<unknown>) | null = null;
      const mockServer = {
        registerTool: vi.fn((_name: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => {
          capturedHandler = handler;
        }),
      };
      const mockLogger = { toolCall: vi.fn(), startup: vi.fn(), shutdown: vi.fn() };
      const failingResolver: ClientResolver = async () => { throw authError; };

      registerReportTool(mockServer as never, failingResolver, mockLogger);

      await expect(capturedHandler!({ report_id: 1, doc_ids: [1] })).rejects.toThrow(
        'OdooAuthError: session expired',
      );
    });
  });
});
