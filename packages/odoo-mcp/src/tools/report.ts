import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

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
  server.registerTool(
    'odoo_run_report',
    {
      description:
        'Render a QWeb PDF report for the given document IDs. Returns base64-encoded PDF content with its MIME type.',
      inputSchema: runReportSchema.shape,
    },
    async (args) => {
      const t0 = Date.now();
      const toolName = 'odoo_run_report';
      const rawArgs = args as unknown as Record<string, unknown>;
      try {
        if (args.allowed_company_ids) {
          validateCompanySubset(args.allowed_company_ids, session.allowedCompanyIds);
        }
        const context: Context = buildContext(session, {
          allowed_company_ids: args.allowed_company_ids,
          active_company_id: args.active_company_id,
        });
        const { content, contentType } = await client.runReport(
          args.report_id,
          args.doc_ids,
          context,
        );
        logger.toolCall({
          tool: toolName,
          args_sanitized: sanitizeArgs(toolName, rawArgs),
          latency_ms: Date.now() - t0,
          status: 'ok',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ content, contentType }) }],
          isError: false,
        };
      } catch (e) {
        const latency_ms = Date.now() - t0;
        if (e instanceof OdooError) {
          const formatted = formatMcpError(e);
          logger.toolCall({
            tool: toolName,
            args_sanitized: sanitizeArgs(toolName, rawArgs),
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
          tool: toolName,
          args_sanitized: sanitizeArgs(toolName, rawArgs),
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
