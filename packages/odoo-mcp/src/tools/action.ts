import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooError, type OdooSession, sanitizeArgs } from '@netlinks/odoo-client';
import type { OdooClient } from '@netlinks/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { callActionSchema } from './schemas.js';

// Threat-model US-5 AC-9 analogue: action_name is dispatched as a method on
// execute_kw, so unrestricted strings would let a caller invoke arbitrary
// ORM methods (e.g. 'unlink') and bypass tool-shaped guardrails.
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

export function registerActionTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  // Use the no-schema overload so we can return InputValidationError manually.
  server.tool('odoo_call_action', async (args: Record<string, unknown>) => {
    const start = Date.now();

    // Step 1: parse with Zod schema
    const parsed = callActionSchema.safeParse(args);
    if (!parsed.success) {
      return inputValidationError(parsed.error.message);
    }

    const data = parsed.data;

    // Step 1b: threat-model guard — reject method names with characters
    // that could bypass the tool-shaped surface (analogous to US-5 AC-9).
    if (!METHOD_RE.test(data.action_name)) {
      return inputValidationError('action_name contains invalid characters');
    }

    // Step 2: validate company subset if provided
    if (data.allowed_company_ids !== undefined) {
      try {
        validateCompanySubset(data.allowed_company_ids, session.allowedCompanyIds);
      } catch (e) {
        if (e instanceof OdooError) {
          const latency_ms = Date.now() - start;
          logger.toolCall({
            tool: 'odoo_call_action',
            args_sanitized: sanitizeArgs('odoo_call_action', args),
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

    // Step 3: merge caller context with company context.
    // buildContext re-applies uid/company_id/allowed_company_ids AFTER extraContext
    // so caller-supplied context CANNOT override identity (US-5 AC-4 + US-7 AC-7).
    const context = buildContext(
      session,
      {
        allowed_company_ids: data.allowed_company_ids,
        active_company_id: data.active_company_id,
      },
      data.context,
    );

    // Step 4: call client.callAction
    try {
      const result = await client.callAction(data.model, data.ids, data.action_name, context);

      const latency_ms = Date.now() - start;

      // Step 5: return result and log
      logger.toolCall({
        tool: 'odoo_call_action',
        args_sanitized: sanitizeArgs('odoo_call_action', args),
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
          tool: 'odoo_call_action',
          args_sanitized: sanitizeArgs('odoo_call_action', args),
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
