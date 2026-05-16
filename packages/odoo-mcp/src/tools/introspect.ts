import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { fieldsGetSchema } from './schemas.js';

export function registerIntrospectTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  server.registerTool(
    'odoo_fields_get',
    {
      description:
        'Introspect a model to discover its fields, types, labels, and constraints. Returns one entry per field.',
      inputSchema: fieldsGetSchema.shape,
    },
    async (args) => {
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;
      try {
        if (args.allowed_company_ids) {
          validateCompanySubset(args.allowed_company_ids, session.allowedCompanyIds);
        }
        const context = buildContext(session, {
          allowed_company_ids: args.allowed_company_ids,
          active_company_id: args.active_company_id,
        });
        const result = await client.fieldsGet(args.model, args.attributes, context);
        logger.toolCall({
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
            tool: 'odoo_fields_get',
            args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
