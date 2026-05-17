import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ClientResolver, RequestContext } from '../types.js';
import { runReportSchema } from './schemas.js';

/** Structural type for AsyncLocalStorage — avoids @types/node dependency. */
type AsyncLocalStorageLike<T> = { getStore(): T | undefined };

/** Retrieve the user_id from AsyncLocalStorage context set by HTTP transport (T-11). */
async function getUserId(): Promise<string | undefined> {
  try {
    // Lazy access — http-transport.ts exports requestContextStorage in T-11
    const httpTransport = (await import('../http-transport.js')) as unknown as {
      requestContextStorage?: AsyncLocalStorageLike<RequestContext>;
    };
    return httpTransport.requestContextStorage?.getStore()?.user_id;
  } catch {
    return undefined;
  }
}

export function registerReportTool(
  server: McpServer,
  clientResolver: ClientResolver,
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
      const { client, session } = await clientResolver();
      const user_id = await getUserId();
      const t0 = Date.now();
      const toolName = 'odoo_run_report';
      const rawArgs = args as unknown as Record<string, unknown>;

      // Validate args — defensive, in addition to SDK-level validation.
      const parseResult = runReportSchema.safeParse(args);
      if (!parseResult.success) {
        const message = parseResult.error.issues.map((i) => i.message).join('; ');
        logger.toolCall({
          tool: toolName,
          args_sanitized: sanitizeArgs(toolName, rawArgs),
          latency_ms: Date.now() - t0,
          status: 'error',
          error: 'InputValidationError',
          user_id,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error_type: 'InputValidationError', message }),
            },
          ],
          isError: true,
        };
      }

      const parsed = parseResult.data;
      try {
        if (parsed.allowed_company_ids) {
          validateCompanySubset(parsed.allowed_company_ids, session.allowedCompanyIds);
        }
        const context: Context = buildContext(session, {
          allowed_company_ids: parsed.allowed_company_ids,
          active_company_id: parsed.active_company_id,
        });
        const { content, contentType } = await client.runReport(
          parsed.report_id,
          parsed.doc_ids,
          context,
        );
        logger.toolCall({
          tool: toolName,
          args_sanitized: sanitizeArgs(toolName, rawArgs),
          latency_ms: Date.now() - t0,
          status: 'ok',
          user_id,
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
            user_id,
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
          user_id,
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
