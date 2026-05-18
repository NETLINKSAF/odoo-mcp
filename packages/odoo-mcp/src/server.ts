import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooClient, type OdooConfig, type ProbeResult } from '@netlinksinc/odoo-client';

import { type Logger, createLogger } from './logger.js';
import { runProbe } from './probe.js';
import { registerResources } from './resources.js';
import { registerAllTools } from './tools/index.js';
import type { ClientResolver } from './types.js';

export interface McpServerConfig {
  odooConfig: OdooConfig;
  logFile?: string;
  clientResolver?: ClientResolver; // undefined = stdio mode (use startup singleton)
}

/**
 * Returns true if every field in the ProbeResult is a success value (not an
 * error object). Used by bin.ts to populate HealthPayload.probe_ok.
 */
function computeProbeOk(probe: ProbeResult): boolean {
  const fields: unknown[] = [
    probe.modules,
    probe.reports,
    probe.serverActions,
    probe.companies,
    probe.currencies,
    probe.fiscalYear,
    probe.language,
    probe.locale,
  ];
  return fields.every((f) => !(typeof f === 'object' && f !== null && 'error' in f));
}

/**
 * Wires all subsystems together and returns the ready-to-connect MCP server
 * along with the logger instance (so bin.ts can call logger.startup and
 * logger.shutdown without opening a second file descriptor on the log file).
 *
 * Authentication errors (OdooAuthError) are intentionally NOT caught here —
 * they propagate to the caller (bin.ts), which serialises them to stderr.
 */
export async function createOdooMcpServer(config: McpServerConfig): Promise<{
  server: McpServer;
  /**
   * Factory that builds a FRESH McpServer instance with the same tools and
   * resources registered. Each HTTP session must connect to its own server
   * instance — the MCP SDK rejects a second `server.connect(transport)` call
   * with "Already connected to a transport". Stdio mode uses the singleton
   * `server` field above; HTTP mode calls this per new session.
   */
  createServerInstance: () => McpServer;
  logger: Logger;
  probeOk: boolean;
  probeClient: OdooClient;
}> {
  // 1. Build the Odoo probe client.
  const probeClient = new OdooClient(config.odooConfig);

  // 2. Authenticate — may throw OdooAuthError; propagate to caller (US-2 AC-3).
  const session = await probeClient.authenticate();

  // 3. Create logger (opens the log-file fd once).
  const logger = createLogger(config.logFile);

  // 4. Run the startup probe (never throws — always resolves).
  const probe = await runProbe(probeClient);

  // 5. Compute whether the probe completed without any field errors.
  const probeOk = computeProbeOk(probe);

  // 6. Determine clientResolver:
  //    - HTTP mode: use the provided resolver (per-user credentials).
  //    - stdio mode: wrap the startup singleton client + session.
  const resolver: ClientResolver = config.clientResolver
    ? config.clientResolver
    : async () => ({ client: probeClient, session });

  // 7. Factory: every call returns a brand-new McpServer with tools + resources.
  //    The resources are static (backed by the probe snapshot) so they're cheap
  //    to re-register; tool handlers close over the shared resolver + logger.
  function createServerInstance(): McpServer {
    const instance = new McpServer({ name: 'odoo-mcp', version: '0.2.1' });
    registerResources(instance, probe);
    registerAllTools(instance, resolver, logger);
    return instance;
  }

  // 8. Singleton server for stdio mode (one process == one transport).
  const server = createServerInstance();

  return { server, createServerInstance, logger, probeOk, probeClient };
}
