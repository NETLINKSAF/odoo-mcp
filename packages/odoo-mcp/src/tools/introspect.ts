import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ClientResolver, RequestContext } from '../types.js';
import { fieldsGetSchema } from './schemas.js';

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

export function registerIntrospectTool(
  server: McpServer,
  clientResolver: ClientResolver,
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
      const { client, session } = await clientResolver();
      const user_id = await getUserId();
      const t0 = Date.now();
      const rawArgs = args as unknown as Record<string, unknown>;

      // Validate args — defensive, in addition to SDK-level validation.
      const parseResult = fieldsGetSchema.safeParse(args);
      if (!parseResult.success) {
        const message = parseResult.error.issues.map((i) => i.message).join('; ');
        logger.toolCall({
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
        const context = buildContext(session, {
          allowed_company_ids: parsed.allowed_company_ids,
          active_company_id: parsed.active_company_id,
        });
        const result = await client.fieldsGet(parsed.model, parsed.attributes, context);
        logger.toolCall({
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
            tool: 'odoo_fields_get',
            args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
          tool: 'odoo_fields_get',
          args_sanitized: sanitizeArgs('odoo_fields_get', rawArgs),
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
