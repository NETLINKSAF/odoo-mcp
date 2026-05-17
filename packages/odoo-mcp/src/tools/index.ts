import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger } from '../logger.js';
import type { ClientResolver } from '../types.js';
import { registerActionTool } from './action.js';
import { registerExecuteTool } from './execute.js';
import { registerIntrospectTool } from './introspect.js';
import { registerOrmTools } from './orm.js';
import { registerReportTool } from './report.js';

export function registerAllTools(
  server: McpServer,
  clientResolver: ClientResolver,
  logger: Logger,
): void {
  registerOrmTools(server, clientResolver, logger);
  registerExecuteTool(server, clientResolver, logger);
  registerReportTool(server, clientResolver, logger);
  registerActionTool(server, clientResolver, logger);
  registerIntrospectTool(server, clientResolver, logger);
}
