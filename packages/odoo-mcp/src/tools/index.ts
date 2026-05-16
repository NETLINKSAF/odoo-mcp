import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OdooClient, OdooSession } from '@netlinksinc/odoo-client';

import type { Logger } from '../logger.js';
import { registerActionTool } from './action.js';
import { registerExecuteTool } from './execute.js';
import { registerIntrospectTool } from './introspect.js';
import { registerOrmTools } from './orm.js';
import { registerReportTool } from './report.js';

export function registerAllTools(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  registerOrmTools(server, client, session, logger);
  registerExecuteTool(server, client, session, logger);
  registerReportTool(server, client, session, logger);
  registerActionTool(server, client, session, logger);
  registerIntrospectTool(server, client, session, logger);
}
