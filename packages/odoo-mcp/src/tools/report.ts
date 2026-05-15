import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinks/odoo-client';
import type { OdooClient } from '@netlinks/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { runReportSchema } from './schemas.js';

export function registerReportTool(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  server.tool('odoo_run_report', async (args) => {
    const t0 = Date.now();
    const toolName = 'odoo_run_report';

    const parsed = runReportSchema.safeParse(args);
    if (!parsed.success) {
      const errorPayload = {
        error_type: 'InputValidationError',
        message: parsed.error.message,
      };
      logger.toolCall({
        tool: toolName,
        args_sanitized: sanitizeArgs(toolName, args as Record<string, unknown>),
        latency_ms: Date.now() - t0,
        status: 'error',
        error: 'InputValidationError',
      });
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify(errorPayload) }],
      };
    }

    const data = parsed.data;

    try {
      if (data.allowed_company_ids !== undefined) {
        validateCompanySubset(data.allowed_company_ids, session.allowedCompanyIds);
      }

      const context: Context = buildContext(session, {
        allowed_company_ids: data.allowed_company_ids,
        active_company_id: data.active_company_id,
      });

      const { content, contentType } = await client.runReport(
        data.report_id,
        data.doc_ids,
        context,
      );

      const latency_ms = Date.now() - t0;
      logger.toolCall({
        tool: toolName,
        args_sanitized: sanitizeArgs(toolName, args as Record<string, unknown>),
        latency_ms,
        status: 'ok',
      });

      return {
        isError: false,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ content, contentType }),
          },
        ],
      };
    } catch (e) {
      const latency_ms = Date.now() - t0;

      if (e instanceof OdooError) {
        logger.toolCall({
          tool: toolName,
          args_sanitized: sanitizeArgs(toolName, args as Record<string, unknown>),
          latency_ms,
          status: 'error',
          error: e.message,
        });

        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(formatMcpError(e)),
            },
          ],
        };
      }

      // Non-OdooError — unexpected exception. Log + return as InternalError-shaped.
      const message = e instanceof Error ? e.message : String(e);
      logger.toolCall({
        tool: toolName,
        args_sanitized: sanitizeArgs(toolName, args as Record<string, unknown>),
        latency_ms,
        status: 'error',
        error: 'InternalError',
      });
      return {
        isError: true,
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
