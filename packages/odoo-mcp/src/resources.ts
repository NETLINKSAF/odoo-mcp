import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProbeResult } from '@netlinks/odoo-client';

/**
 * Registers 7 MCP resources on the given server, each backed by a closure
 * over the already-resolved `probe` — no re-query to Odoo (US-3 AC-5).
 *
 * If a probe field is `{ error: string }`, the resource returns that object
 * as JSON content (US-3 AC-3 — error transparency, no throw).
 */
export function registerResources(server: McpServer, probe: ProbeResult): void {
  const resources: Array<{
    name: string;
    uri: string;
    data: unknown;
  }> = [
    { name: 'modules', uri: 'odoo://modules', data: probe.modules },
    { name: 'reports', uri: 'odoo://reports', data: probe.reports },
    { name: 'server-actions', uri: 'odoo://server-actions', data: probe.serverActions },
    { name: 'companies', uri: 'odoo://companies', data: probe.companies },
    { name: 'currencies', uri: 'odoo://currencies', data: probe.currencies },
    { name: 'fiscal-year', uri: 'odoo://fiscal-year', data: probe.fiscalYear },
    {
      name: 'user-context',
      uri: 'odoo://user-context',
      data: { language: probe.language, locale: probe.locale },
    },
  ];

  for (const { name, uri, data } of resources) {
    // Capture uri and data in closure — no re-query on each read.
    const capturedUri = uri;
    const capturedData = data;

    server.resource(name, capturedUri, (_url) => ({
      contents: [
        {
          uri: capturedUri,
          mimeType: 'application/json',
          text: JSON.stringify(capturedData),
        },
      ],
    }));
  }
}
