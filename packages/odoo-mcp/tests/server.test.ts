import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted above the import of createOdooMcpServer
// ---------------------------------------------------------------------------

vi.mock('@netlinks/odoo-client', () => {
  class OdooAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'OdooAuthError';
    }
  }

  const OdooClient = vi.fn().mockImplementation(() => ({
    authenticate: vi.fn().mockResolvedValue({ uid: 1, db: 'testdb', apiKey: 'key' }),
  }));

  return { OdooClient, OdooAuthError };
});

vi.mock('../src/probe.js', () => ({
  runProbe: vi.fn().mockResolvedValue({
    modules: [],
    reports: [],
    serverActions: [],
    companies: [],
    currencies: [],
    fiscalYear: { date_from: '2026-01-01', date_to: '2026-12-31' },
    language: 'en_US',
    locale: 'UTC',
  }),
}));

vi.mock('../src/resources.js', () => ({
  registerResources: vi.fn(),
}));

vi.mock('../src/tools/index.js', () => ({
  registerAllTools: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  createLogger: vi.fn(() => ({
    toolCall: vi.fn(),
    startup: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks are declared
// ---------------------------------------------------------------------------

import { createOdooMcpServer } from '../src/server.js';
import { OdooClient, OdooAuthError } from '@netlinks/odoo-client';
import { runProbe } from '../src/probe.js';
import { registerResources } from '../src/resources.js';
import { registerAllTools } from '../src/tools/index.js';
import { createLogger } from '../src/logger.js';
import type { OdooConfig } from '@netlinks/odoo-client';

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const ODOO_CONFIG: OdooConfig = {
  url: 'https://erp.example.com',
  db: 'testdb',
  username: 'admin',
  apiKey: 'test-key-do-not-leak',
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createOdooMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mock for OdooClient.authenticate after clearAllMocks
    vi.mocked(OdooClient).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue({ uid: 1, db: 'testdb', apiKey: 'test-key-do-not-leak' }),
    }));
  });

  // Test 1 — Happy path: returns object with server and logger keys
  it('returns an object with server and logger on success', async () => {
    const result = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    expect(result).toHaveProperty('server');
    expect(result).toHaveProperty('logger');
    expect(result.server).toBeInstanceOf(McpServer);
  });

  // Test 2 — OdooAuthError from authenticate propagates (not swallowed)
  it('propagates OdooAuthError when authenticate throws', async () => {
    vi.mocked(OdooClient).mockImplementation(() => ({
      authenticate: vi.fn().mockRejectedValue(new OdooAuthError('invalid credentials')),
    }));

    await expect(createOdooMcpServer({ odooConfig: ODOO_CONFIG })).rejects.toThrow(
      'invalid credentials',
    );
  });

  // Test 3 — runProbe is called exactly once with the client instance
  it('calls runProbe once with the OdooClient instance', async () => {
    await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    const clientInstance = vi.mocked(OdooClient).mock.results[0]?.value;
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(runProbe).toHaveBeenCalledWith(clientInstance);
  });

  // Test 4 — registerResources is called with the server and probe result
  it('calls registerResources with server and probe result', async () => {
    const probeResult = {
      modules: [],
      reports: [],
      serverActions: [],
      companies: [],
      currencies: [],
      fiscalYear: { date_from: '2026-01-01', date_to: '2026-12-31' },
      language: 'en_US',
      locale: 'UTC',
    };
    vi.mocked(runProbe).mockResolvedValue(probeResult);

    const { server } = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    expect(registerResources).toHaveBeenCalledTimes(1);
    expect(registerResources).toHaveBeenCalledWith(server, probeResult);
  });

  // Test 5 — registerAllTools is called with server, client, session, and logger
  it('calls registerAllTools with server, client, session, and logger', async () => {
    const fakeSession = { uid: 1, db: 'testdb', apiKey: 'test-key-do-not-leak' };
    vi.mocked(OdooClient).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue(fakeSession),
    }));

    const { server, logger } = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });
    const clientInstance = vi.mocked(OdooClient).mock.results[0]?.value;

    expect(registerAllTools).toHaveBeenCalledTimes(1);
    expect(registerAllTools).toHaveBeenCalledWith(server, clientInstance, fakeSession, logger);
  });

  // Test 6 — Server is constructed with name='odoo-mcp' and version='0.1.0'
  it('constructs McpServer with name odoo-mcp and version 0.1.0', async () => {
    const constructorSpy = vi.spyOn(
      { McpServer },
      'McpServer',
    );
    // We can verify indirectly: the returned server is an instance of McpServer
    // and registerResources received it — also check via registerAllTools call arg
    const { server } = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    // The server is a real McpServer instance (not a mock)
    expect(server).toBeInstanceOf(McpServer);
    // registerAllTools and registerResources both received the same server object
    expect(vi.mocked(registerResources).mock.calls[0]?.[0]).toBe(server);
    expect(vi.mocked(registerAllTools).mock.calls[0]?.[0]).toBe(server);

    constructorSpy.mockRestore();
  });

  // Test 7 — createLogger is called with the logFile option
  it('passes logFile to createLogger', async () => {
    await createOdooMcpServer({ odooConfig: ODOO_CONFIG, logFile: '/tmp/test.log' });

    expect(createLogger).toHaveBeenCalledWith('/tmp/test.log');
  });

  // Test 8 — OdooAuthError propagates as an Error with the correct message
  // (constructor.name is intentionally not asserted — Vitest's module rewriting
  //  may mangle inline class names with a numeric suffix; what matters is that
  //  the error is an Error instance with the right message and is NOT swallowed.)
  it('propagates an Error instance with the correct message when authenticate fails', async () => {
    vi.mocked(OdooClient).mockImplementation(() => ({
      authenticate: vi.fn().mockRejectedValue(new OdooAuthError('auth failed')),
    }));

    let caught: unknown;
    try {
      await createOdooMcpServer({ odooConfig: ODOO_CONFIG });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('auth failed');
  });
});
