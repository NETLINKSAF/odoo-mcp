import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooClient, type OdooConfig } from '@netlinksinc/odoo-client';

import { type Logger, createLogger } from './logger.js';
import { runProbe } from './probe.js';
import { registerResources } from './resources.js';
import { registerAllTools } from './tools/index.js';

export interface McpServerConfig {
  odooConfig: OdooConfig;
  logFile?: string;
}

/**
 * Wires all subsystems together and returns the ready-to-connect MCP server
 * along with the logger instance (so bin.ts can call logger.startup and
 * logger.shutdown without opening a second file descriptor on the log file).
 *
 * Authentication errors (OdooAuthError) are intentionally NOT caught here —
 * they propagate to the caller (bin.ts), which serialises them to stderr.
 */
export async function createOdooMcpServer(
  config: McpServerConfig,
): Promise<{ server: McpServer; logger: Logger }> {
  // 1. Build the Odoo client.
  const client = new OdooClient(config.odooConfig);

  // 2. Authenticate — may throw OdooAuthError; propagate to caller (US-2 AC-3).
  const session = await client.authenticate();

  // 3. Create logger (opens the log-file fd once).
  const logger = createLogger(config.logFile);

  // 4. Run the startup probe (never throws — always resolves).
  const probe = await runProbe(client);

  // 5. Create the MCP server.
  const server = new McpServer({ name: 'odoo-mcp', version: '0.1.0' });

  // 6. Register resources (static, backed by probe snapshot).
  registerResources(server, probe);

  // 7. Register all tool handlers.
  registerAllTools(server, client, session, logger);

  return { server, logger };
}
