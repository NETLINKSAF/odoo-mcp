import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ClientResolver, RequestContext } from '../types.js';
import { callActionSchema } from './schemas.js';

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

export function registerActionTool(
  server: McpServer,
  clientResolver: ClientResolver,
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
      const { client, session } = await clientResolver();
      const user_id = await getUserId();
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;

      // Validate args — defensive, in addition to SDK-level validation.
      const parseResult = callActionSchema.safeParse(args);
      if (!parseResult.success) {
        const message = parseResult.error.issues.map((i) => i.message).join('; ');
        logger.toolCall({
          tool: 'odoo_call_action',
          args_sanitized: sanitizeArgs('odoo_call_action', rawArgs),
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
        // buildContext re-applies session-authoritative fields AFTER extraContext
        // so caller-supplied context cannot override identity (US-5 AC-4 + US-7 AC-7).
        const context = buildContext(
          session,
          {
            allowed_company_ids: parsed.allowed_company_ids,
            active_company_id: parsed.active_company_id,
          },
          parsed.context,
        );
        const result = await client.callAction(
          parsed.model,
          parsed.ids,
          parsed.action_name,
          context,
        );
        logger.toolCall({
          tool: 'odoo_call_action',
          args_sanitized: sanitizeArgs('odoo_call_action', rawArgs),
          latency_ms: Date.now() - t0,
          status: 'ok',
          user_id,
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
            user_id,
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
          error_message: message,
          user_id,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error_type: 'InternalError',
                message: 'An internal error occurred',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
