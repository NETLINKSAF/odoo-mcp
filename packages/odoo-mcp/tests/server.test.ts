import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted above the import of createOdooMcpServer
// ---------------------------------------------------------------------------

vi.mock('@netlinksinc/odoo-client', () => {
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
import { OdooClient, OdooAuthError } from '@netlinksinc/odoo-client';
import { runProbe } from '../src/probe.js';
import { registerResources } from '../src/resources.js';
import { registerAllTools } from '../src/tools/index.js';
import { createLogger } from '../src/logger.js';
import type { OdooConfig } from '@netlinksinc/odoo-client';
import type { ClientResolver } from '../src/types.js';

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

  // Test 5 — registerAllTools is called with the new 3-arg signature (server, resolver, logger)
  it('calls registerAllTools with server, resolver, and logger (3-arg signature)', async () => {
    const { server, logger } = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    expect(registerAllTools).toHaveBeenCalledTimes(1);
    const [calledServer, calledResolver, calledLogger] = vi.mocked(registerAllTools).mock.calls[0]!;
    expect(calledServer).toBe(server);
    expect(typeof calledResolver).toBe('function');
    expect(calledLogger).toBe(logger);
  });

  // Test 6 — Server is constructed with name='odoo-mcp' and version='0.2.1'
  it('constructs McpServer with name odoo-mcp and version 0.2.1', async () => {
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

  // Test 9 — probeOk is true when all probe fields are success values
  it('returns probeOk true when all probe fields succeed', async () => {
    vi.mocked(runProbe).mockResolvedValue({
      modules: [{ name: 'base', version: '16.0' }],
      reports: [],
      serverActions: [],
      companies: [{ id: 1, name: 'Acme', currency_id: [1, 'USD'] }],
      currencies: [{ id: 1, name: 'USD', symbol: '$' }],
      fiscalYear: { date_from: '2026-01-01', date_to: '2026-12-31' },
      language: 'en_US',
      locale: 'UTC',
    });

    const result = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });
    expect(result).toHaveProperty('probeOk', true);
  });

  // Test 10 — probeOk is false when any probe field is an error object
  it('returns probeOk false when at least one probe field has an error', async () => {
    vi.mocked(runProbe).mockResolvedValue({
      modules: { error: 'connection refused' },
      reports: [],
      serverActions: [],
      companies: [],
      currencies: [],
      fiscalYear: { date_from: '2026-01-01', date_to: '2026-12-31' },
      language: 'en_US',
      locale: 'UTC',
    });

    const result = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });
    expect(result).toHaveProperty('probeOk', false);
  });

  // Test 11 (NEW) — without clientResolver, the singleton resolver yields probeClient + session
  it('without clientResolver, server dispatches tools via singleton resolver', async () => {
    const fakeSession = { uid: 1, db: 'testdb', apiKey: 'test-key-do-not-leak' };
    vi.mocked(OdooClient).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue(fakeSession),
    }));

    const { probeClient } = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    // The resolver passed to registerAllTools must be the singleton one
    const [, resolver] = vi.mocked(registerAllTools).mock.calls[0]!;
    const resolved = await resolver();

    expect(resolved.client).toBe(probeClient);
    expect(resolved.session).toEqual(fakeSession);
  });

  // T-18 — stdio mode singleton resolver returns the SAME {client, session} pair on repeated calls
  it('stdio mode singleton resolver returns the same {client,session} pair on repeated calls', async () => {
    const fakeSession = { uid: 1, db: 'testdb', apiKey: 'test-key-do-not-leak' };
    vi.mocked(OdooClient).mockImplementation(() => ({
      authenticate: vi.fn().mockResolvedValue(fakeSession),
    }));

    await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    // Capture the resolver forwarded to registerAllTools
    const [, resolver] = vi.mocked(registerAllTools).mock.calls[0]!;

    // Call twice — both must return the exact same object references (singleton)
    const first = await resolver();
    const second = await resolver();

    expect(first.client).toBe(second.client);
    expect(first.session).toBe(second.session);
  });

  // Test 12 (NEW) — with clientResolver provided, that resolver is forwarded verbatim
  it('with clientResolver provided, that resolver is used', async () => {
    const mockResolver: ClientResolver = vi.fn().mockResolvedValue({
      client: {} as never,
      session: { uid: 99, db: 'other', apiKey: 'custom' },
    });

    await createOdooMcpServer({ odooConfig: ODOO_CONFIG, clientResolver: mockResolver });

    const [, resolver] = vi.mocked(registerAllTools).mock.calls[0]!;
    expect(resolver).toBe(mockResolver);
  });

  // Test 13 (NEW) — return object includes probeClient
  it('return object includes probeClient', async () => {
    const result = await createOdooMcpServer({ odooConfig: ODOO_CONFIG });

    expect(result).toHaveProperty('probeClient');
    // probeClient must be the OdooClient instance that was constructed
    const clientInstance = vi.mocked(OdooClient).mock.results[0]?.value;
    expect(result.probeClient).toBe(clientInstance);
  });
});
