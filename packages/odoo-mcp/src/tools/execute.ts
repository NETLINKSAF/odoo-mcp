import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { executeSchema } from './schemas.js';

export function registerExecuteTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  server.registerTool(
    'odoo_execute',
    {
      description:
        'Call any model method (execute_kw). Use this for operations not covered by the typed CRUD tools. Model and method are regex-validated.',
      inputSchema: executeSchema.shape,
    },
    async (args) => {
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;
      try {
        if (args.allowed_company_ids) {
          validateCompanySubset(args.allowed_company_ids, session.allowedCompanyIds);
        }
        const context: Context = buildContext(session, {
          allowed_company_ids: args.allowed_company_ids,
          active_company_id: args.active_company_id,
        });
        const result = await client.execute(
          args.model,
          args.method,
          args.args,
          args.kwargs,
          context,
        );
        logger.toolCall({
          tool: 'odoo_execute',
          args_sanitized: sanitizeArgs('odoo_execute', rawArgs),
          latency_ms: Date.now() - t0,
          status: 'ok',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: false,
        };
      } catch (e) {
        const latency_ms = Date.now() - t0;
        if (e instanceof OdooError) {
          const formatted = formatMcpError(e);
          logger.toolCall({
            tool: 'odoo_execute',
            args_sanitized: sanitizeArgs('odoo_execute', rawArgs),
            latency_ms,
            status: 'error',
            error: formatted.error_type,
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(formatted) }],
            isError: true,
          };
        }
        const message = e instanceof Error ? e.message : String(e);
        logger.toolCall({
          tool: 'odoo_execute',
          args_sanitized: sanitizeArgs('odoo_execute', rawArgs),
          latency_ms,
          status: 'error',
          error: 'InternalError',
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error_type: 'InternalError',
                message: 'unexpected error',
                detail: message,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
