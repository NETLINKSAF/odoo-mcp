import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooError, type OdooSession, sanitizeArgs } from '@netlinks/odoo-client';
import type { OdooClient } from '@netlinks/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { fieldsGetSchema } from './schemas.js';

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

export function registerIntrospectTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  server.tool('odoo_fields_get', async (args: Record<string, unknown>) => {
    const start = Date.now();

    // Step 1: parse with Zod schema (model regex enforced via MODEL_NAME)
    const parsed = fieldsGetSchema.safeParse(args);
    if (!parsed.success) {
      logger.toolCall({
        tool: 'odoo_fields_get',
        args_sanitized: sanitizeArgs('odoo_fields_get', args),
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
            tool: 'odoo_fields_get',
            args_sanitized: sanitizeArgs('odoo_fields_get', args),
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
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', args),
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

    // Step 3: build context (no extraContext for fields_get)
    const context = buildContext(session, {
      allowed_company_ids: data.allowed_company_ids,
      active_company_id: data.active_company_id,
    });

    // Step 4: call client.fieldsGet — pass attributes as-is (undefined if not provided)
    try {
      const result = await client.fieldsGet(data.model, data.attributes, context);

      const latency_ms = Date.now() - start;

      // Step 5: return result and log
      logger.toolCall({
        tool: 'odoo_fields_get',
        args_sanitized: sanitizeArgs('odoo_fields_get', args),
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
      // Step 6: on OdooError, format and return isError:true
      if (e instanceof OdooError) {
        const latency_ms = Date.now() - start;
        logger.toolCall({
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', args),
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
      // Step 7: Non-OdooError — unexpected exception. Log + return as InternalError-shaped.
      const message = e instanceof Error ? e.message : String(e);
      const latency_ms = Date.now() - start;
      logger.toolCall({
        tool: 'odoo_fields_get',
        args_sanitized: sanitizeArgs('odoo_fields_get', args),
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
