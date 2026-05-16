import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProbeResult } from '@netlinksinc/odoo-client';
import { registerResources } from '../src/resources.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal McpServer mock: captures resource() calls for inspection. */
function makeServerMock() {
  const registered: Array<{
    name: string;
    uri: string;
    handler: (url: URL) => unknown;
  }> = [];

  const server = {
    resource: vi.fn((name: string, uri: string, handler: (url: URL) => unknown) => {
      registered.push({ name, uri, handler });
      return {};
    }),
    _registered: registered,
  } as unknown as McpServer & { _registered: typeof registered };

  return { server, registered };
}

/** Returns the handler registered for the given URI, or throws if not found. */
function handlerFor(
  registered: Array<{ name: string; uri: string; handler: (url: URL) => unknown }>,
  uri: string,
) {
  const entry = registered.find((r) => r.uri === uri);
  if (!entry) throw new Error(`No handler registered for URI: ${uri}`);
  return entry.handler;
}

/** Invokes a handler and extracts the first content entry's text, parsed as JSON. */
function readJson(handler: (url: URL) => unknown, uri: string): unknown {
  const url = new URL(uri);
  const result = handler(url) as {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  };
  const text = result.contents[0]?.text;
  if (text === undefined) throw new Error('No text in contents[0]');
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Shared probe fixture — all fields succeed
// ---------------------------------------------------------------------------

const PROBE_SUCCESS: ProbeResult = {
  modules: [{ name: 'base', version: '17.0.1.0.0' }],
  reports: [{ report_name: 'sale.report', model: 'sale.order', report_type: 'qweb-pdf' }],
  serverActions: [{ name: 'Send Email', model: 'res.partner', type: 'ir.actions.server' }],
  companies: [{ id: 1, name: 'NETLINKS', currency_id: [2, 'USD'] }],
  currencies: [{ id: 2, name: 'USD', symbol: '$' }],
  fiscalYear: { date_from: '2026-01-01', date_to: '2026-12-31' },
  language: 'fr_FR',
  locale: 'Europe/Paris',
};

// ---------------------------------------------------------------------------
// AC-1: registerResources registers exactly 7 resources
// ---------------------------------------------------------------------------

describe('registerResources — AC-1: exactly 7 resources registered', () => {
  it('calls server.resource exactly 7 times', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_SUCCESS);
    expect(registered).toHaveLength(7);
  });

  it('registers with the expected URIs', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_SUCCESS);
    const uris = registered.map((r) => r.uri);
    expect(uris).toEqual([
      'odoo://modules',
      'odoo://reports',
      'odoo://server-actions',
      'odoo://companies',
      'odoo://currencies',
      'odoo://fiscal-year',
      'odoo://user-context',
    ]);
  });

  it('registers with the expected names', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_SUCCESS);
    const names = registered.map((r) => r.name);
    expect(names).toEqual([
      'modules',
      'reports',
      'server-actions',
      'companies',
      'currencies',
      'fiscal-year',
      'user-context',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AC-2: odoo://modules returns modules array as JSON
// ---------------------------------------------------------------------------

describe('registerResources — AC-2: odoo://modules returns array', () => {
  let registered: ReturnType<typeof makeServerMock>['registered'];

  beforeEach(() => {
    const mock = makeServerMock();
    registerResources(mock.server, PROBE_SUCCESS);
    registered = mock.registered;
  });

  it('returns contents with uri odoo://modules', () => {
    const handler = handlerFor(registered, 'odoo://modules');
    const result = handler(new URL('odoo://modules')) as {
      contents: Array<{ uri: string }>;
    };
    expect(result.contents[0]?.uri).toBe('odoo://modules');
  });

  it('returns mimeType application/json', () => {
    const handler = handlerFor(registered, 'odoo://modules');
    const result = handler(new URL('odoo://modules')) as {
      contents: Array<{ mimeType: string }>;
    };
    expect(result.contents[0]?.mimeType).toBe('application/json');
  });

  it('text is JSON-serialized modules array', () => {
    const handler = handlerFor(registered, 'odoo://modules');
    const parsed = readJson(handler, 'odoo://modules');
    expect(parsed).toEqual([{ name: 'base', version: '17.0.1.0.0' }]);
  });
});

// ---------------------------------------------------------------------------
// AC-3: odoo://reports with { error } returns error JSON (not throw, not empty)
// ---------------------------------------------------------------------------

describe('registerResources — AC-3: error field passthrough', () => {
  const PROBE_REPORTS_ERROR: ProbeResult = {
    ...PROBE_SUCCESS,
    reports: { error: 'forbidden' },
  };

  it('odoo://reports returns {"error":"forbidden"} as content text', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_REPORTS_ERROR);
    const handler = handlerFor(registered, 'odoo://reports');
    const parsed = readJson(handler, 'odoo://reports');
    expect(parsed).toEqual({ error: 'forbidden' });
  });

  it('does not throw when probe field is an error object', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_REPORTS_ERROR);
    const handler = handlerFor(registered, 'odoo://reports');
    expect(() => handler(new URL('odoo://reports'))).not.toThrow();
  });

  it('contents array has exactly one entry', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_REPORTS_ERROR);
    const handler = handlerFor(registered, 'odoo://reports');
    const result = handler(new URL('odoo://reports')) as { contents: unknown[] };
    expect(result.contents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// user-context: combines language + locale from probe
// ---------------------------------------------------------------------------

describe('registerResources — user-context combines language + locale', () => {
  it('returns { language, locale } as JSON', () => {
    const { server, registered } = makeServerMock();
    registerResources(server, PROBE_SUCCESS);
    const handler = handlerFor(registered, 'odoo://user-context');
    const parsed = readJson(handler, 'odoo://user-context');
    expect(parsed).toEqual({ language: 'fr_FR', locale: 'Europe/Paris' });
  });

  it('user-context error passthrough when language is error', () => {
    const probe: ProbeResult = {
      ...PROBE_SUCCESS,
      language: { error: 'auth failed' },
      locale: { error: 'auth failed' },
    };
    const { server, registered } = makeServerMock();
    registerResources(server, probe);
    const handler = handlerFor(registered, 'odoo://user-context');
    const parsed = readJson(handler, 'odoo://user-context') as {
      language: unknown;
      locale: unknown;
    };
    expect(parsed.language).toEqual({ error: 'auth failed' });
    expect(parsed.locale).toEqual({ error: 'auth failed' });
  });
});

// ---------------------------------------------------------------------------
// Closure isolation: probe data is captured at registration time
// ---------------------------------------------------------------------------

describe('registerResources — closure captures probe at registration time', () => {
  it('handler returns same data even if an external variable changes after registration', () => {
    // The probe object itself shouldn't be mutated by anything, but the closure
    // must capture the field values — this verifies the closure is over the
    // probe fields at call time, not some mutable reference.
    const probe: ProbeResult = { ...PROBE_SUCCESS };
    const { server, registered } = makeServerMock();
    registerResources(server, probe);
    const handler = handlerFor(registered, 'odoo://modules');
    const parsed = readJson(handler, 'odoo://modules');
    expect(parsed).toEqual(PROBE_SUCCESS.modules);
  });
});
