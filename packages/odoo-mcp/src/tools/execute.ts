import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinks/odoo-client';
import type { OdooClient } from '@netlinks/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { executeSchema } from './schemas.js';

// Threat-model US-5 AC-9: safe identifier regexes
const MODEL_RE = /^[a-z][a-z0-9_.]*$/;
const METHOD_RE = /^[a-z_][a-z0-9_]*$/;

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

    // Step 1: parse with Zod schema
    const parsed = executeSchema.safeParse(args);
    if (!parsed.success) {
      return inputValidationError(parsed.error.message);
    }

    const data = parsed.data;

    // Step 2: threat-model US-5 AC-9 — validate model and method identifiers
    if (!MODEL_RE.test(data.model) || !METHOD_RE.test(data.method)) {
      return inputValidationError('model or method contains invalid characters');
    }

    // Step 3: validate company subset if provided
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
        throw e;
      }
    }

    // Step 4: build context
    const context: Context = buildContext(session, {
      allowed_company_ids: data.allowed_company_ids,
      active_company_id: data.active_company_id,
    });

    // Step 5: call client.execute
    try {
      const result = await client.execute(data.model, data.method, data.args, data.kwargs, context);

      const latency_ms = Date.now() - start;

      // Step 6 & 7: return result and log
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
      // Step 8: on OdooError, format and return isError:true
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
      throw e;
    }
  });
}
