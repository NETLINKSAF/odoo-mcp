import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { callActionSchema } from './schemas.js';

export function registerActionTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  server.registerTool(
    'odoo_call_action',
    {
      description:
        'Call a named server action (a method) on a model. Caller-supplied `context` merges with session context but cannot override `uid` or `company_id`.',
      inputSchema: callActionSchema.shape,
    },
    async (args) => {
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;
      try {
        if (args.allowed_company_ids) {
          validateCompanySubset(args.allowed_company_ids, session.allowedCompanyIds);
        }
        // buildContext re-applies session-authoritative fields AFTER extraContext
        // so caller-supplied context cannot override identity (US-5 AC-4 + US-7 AC-7).
        const context = buildContext(
          session,
          {
            allowed_company_ids: args.allowed_company_ids,
            active_company_id: args.active_company_id,
          },
          args.context,
        );
        const result = await client.callAction(args.model, args.ids, args.action_name, context);
        logger.toolCall({
          tool: 'odoo_call_action',
          args_sanitized: sanitizeArgs('odoo_call_action', rawArgs),
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
            tool: 'odoo_call_action',
            args_sanitized: sanitizeArgs('odoo_call_action', rawArgs),
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
          tool: 'odoo_call_action',
          args_sanitized: sanitizeArgs('odoo_call_action', rawArgs),
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
