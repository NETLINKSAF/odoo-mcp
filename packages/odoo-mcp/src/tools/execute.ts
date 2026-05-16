import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { executeSchema } from './schemas.js';

function inputValidationError(message: string) {
  return {
    isError: true as const,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error_type: 'InputValidationError', message }),
      },
    ],
  };
}

export function registerExecuteTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  // Use the no-schema overload so we can return InputValidationError manually.
  server.tool('odoo_execute', async (args: Record<string, unknown>) => {
    const start = Date.now();

    // Step 1: parse with Zod schema (includes model + method regex via MODEL_NAME/METHOD_NAME)
    const parsed = executeSchema.safeParse(args);
    if (!parsed.success) {
      logger.toolCall({
        tool: 'odoo_execute',
        args_sanitized: sanitizeArgs('odoo_execute', args),
        latency_ms: Date.now() - start,
        status: 'error',
        error: 'InputValidationError',
      });
      return inputValidationError(parsed.error.message);
    }

    const data = parsed.data;

    // Step 2: validate company subset if provided
    if (data.allowed_company_ids !== undefined) {
      try {
        validateCompanySubset(data.allowed_company_ids, session.allowedCompanyIds);
      } catch (e) {
        if (e instanceof OdooError) {
          const latency_ms = Date.now() - start;
          logger.toolCall({
            tool: 'odoo_execute',
            args_sanitized: sanitizeArgs('odoo_execute', args),
            latency_ms,
            status: 'error',
            error: e.message,
          });
          return {
            isError: true as const,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(formatMcpError(e)),
              },
            ],
          };
        }
        // Non-OdooError from company validation — log and return as InternalError.
        const message = e instanceof Error ? e.message : String(e);
        const latency_ms = Date.now() - start;
        logger.toolCall({
          tool: 'odoo_execute',
          args_sanitized: sanitizeArgs('odoo_execute', args),
          latency_ms,
          status: 'error',
          error: 'InternalError',
        });
        return {
          isError: true as const,
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
        };
      }
    }

    // Step 3: build context
    const context: Context = buildContext(session, {
      allowed_company_ids: data.allowed_company_ids,
      active_company_id: data.active_company_id,
    });

    // Step 4: call client.execute
    try {
      const result = await client.execute(data.model, data.method, data.args, data.kwargs, context);

      const latency_ms = Date.now() - start;

      // Step 5 & 6: return result and log
      logger.toolCall({
        tool: 'odoo_execute',
        args_sanitized: sanitizeArgs('odoo_execute', args),
        latency_ms,
        status: 'ok',
      });

      return {
        isError: false as const,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (e) {
      // Step 7: on OdooError, format and return isError:true
      if (e instanceof OdooError) {
        const latency_ms = Date.now() - start;
        logger.toolCall({
          tool: 'odoo_execute',
          args_sanitized: sanitizeArgs('odoo_execute', args),
          latency_ms,
          status: 'error',
          error: e.message,
        });
        return {
          isError: true as const,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(formatMcpError(e)),
            },
          ],
        };
      }
      // Step 8: Non-OdooError — unexpected exception. Log + return as InternalError-shaped.
      const message = e instanceof Error ? e.message : String(e);
      const latency_ms = Date.now() - start;
      logger.toolCall({
        tool: 'odoo_execute',
        args_sanitized: sanitizeArgs('odoo_execute', args),
        latency_ms,
        status: 'error',
        error: 'InternalError',
      });
      return {
        isError: true as const,
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
      };
    }
  });
}
