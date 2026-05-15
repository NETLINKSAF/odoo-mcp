import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinks/odoo-client';
import type { OdooClient } from '@netlinks/odoo-client';
import type { z } from 'zod';

import { buildContext, validateCompanySubset } from '../context.js';
import { formatMcpError } from '../errors.js';
import type { Logger } from '../logger.js';
import {
  createSchema,
  readSchema,
  searchCountSchema,
  searchReadSchema,
  unlinkSchema,
  writeSchema,
} from './schemas.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
};

/**
 * Central handler for all ORM tool invocations.
 *
 * Sequence:
 *  1. Parse/validate args with the schema (returns isError on failure).
 *  2. Validate allowed_company_ids against session (returns isError on failure).
 *  3. Build Odoo RPC context.
 *  4. Execute the client method.
 *  5. Return serialised result or formatted OdooError.
 *
 * The callback is registered with the 2-arg overload `server.tool(name, cb)` so
 * that tests can drive it via a simple mock that stores and directly calls `cb`.
 * Inside the callback we perform our own safeParse so validation failures produce
 * `isError: true` (not a thrown McpError as the SDK's schema-overload would do).
 */
async function executeHandler<T>(
  tool: string,
  args: unknown,
  schema: z.ZodSchema<T>,
  exec: (parsed: T, context: Context) => Promise<unknown>,
  logger: Logger,
  session: OdooSession,
): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      const text = JSON.stringify({
        error_type: 'InputValidationError',
        message: parsed.error.message,
      });
      logger.toolCall({
        tool,
        args_sanitized: sanitizeArgs(tool, args as Record<string, unknown>),
        latency_ms: Date.now() - t0,
        status: 'error',
        error: 'InputValidationError',
      });
      return { content: [{ type: 'text', text }], isError: true };
    }

    // Company-subset enforcement (US-7 AC-7).
    const data = parsed.data as {
      allowed_company_ids?: number[];
      active_company_id?: number;
    };
    if (data.allowed_company_ids) {
      validateCompanySubset(data.allowed_company_ids, session.allowedCompanyIds);
    }

    const context = buildContext(session, {
      allowed_company_ids: data.allowed_company_ids,
      active_company_id: data.active_company_id,
    });

    const result = await exec(parsed.data, context);
    logger.toolCall({
      tool,
      args_sanitized: sanitizeArgs(tool, args as Record<string, unknown>),
      latency_ms: Date.now() - t0,
      status: 'ok',
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  } catch (e) {
    if (e instanceof OdooError) {
      const formatted = formatMcpError(e);
      logger.toolCall({
        tool,
        args_sanitized: sanitizeArgs(tool, args as Record<string, unknown>),
        latency_ms: Date.now() - t0,
        status: 'error',
        error: formatted.error_type,
      });
      return { content: [{ type: 'text', text: JSON.stringify(formatted) }], isError: true };
    }
    throw e;
  }
}

/**
 * Register all 6 ORM tools on the MCP server.
 *
 * Tools registered: odoo_search_read, odoo_read, odoo_create, odoo_write,
 * odoo_unlink, odoo_search_count.
 *
 * The server.tool(name, cb) 2-arg overload is used deliberately so that
 * validation failures return `isError: true` rather than a thrown McpError.
 * Tests drive the handlers via a lightweight mock that stores the callback.
 */
export function registerOrmTools(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  // -------------------------------------------------------------------------
  // odoo_search_read
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK no-schema tool() overload signature mismatch
  (server.tool as any)(
    'odoo_search_read',
    async (args: unknown): Promise<ToolResult> =>
      executeHandler(
        'odoo_search_read',
        args,
        searchReadSchema,
        (parsed, context) =>
          client.searchRead(parsed.model, parsed.domain as never[], parsed.fields, {
            limit: parsed.limit,
            offset: parsed.offset,
            order: parsed.order,
            context,
          }),
        logger,
        session,
      ),
  );

  // -------------------------------------------------------------------------
  // odoo_read
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK no-schema tool() overload signature mismatch
  (server.tool as any)(
    'odoo_read',
    async (args: unknown): Promise<ToolResult> =>
      executeHandler(
        'odoo_read',
        args,
        readSchema,
        (parsed, context) => client.read(parsed.model, parsed.ids, parsed.fields, context),
        logger,
        session,
      ),
  );

  // -------------------------------------------------------------------------
  // odoo_create
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK no-schema tool() overload signature mismatch
  (server.tool as any)(
    'odoo_create',
    async (args: unknown): Promise<ToolResult> =>
      executeHandler(
        'odoo_create',
        args,
        createSchema,
        (parsed, context) =>
          client.create(
            parsed.model,
            parsed.values as Record<string, unknown> | Record<string, unknown>[],
            context,
          ),
        logger,
        session,
      ),
  );

  // -------------------------------------------------------------------------
  // odoo_write
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK no-schema tool() overload signature mismatch
  (server.tool as any)(
    'odoo_write',
    async (args: unknown): Promise<ToolResult> =>
      executeHandler(
        'odoo_write',
        args,
        writeSchema,
        (parsed, context) => client.write(parsed.model, parsed.ids, parsed.values, context),
        logger,
        session,
      ),
  );

  // -------------------------------------------------------------------------
  // odoo_unlink
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK no-schema tool() overload signature mismatch
  (server.tool as any)(
    'odoo_unlink',
    async (args: unknown): Promise<ToolResult> =>
      executeHandler(
        'odoo_unlink',
        args,
        unlinkSchema,
        (parsed, context) => client.unlink(parsed.model, parsed.ids, context),
        logger,
        session,
      ),
  );

  // -------------------------------------------------------------------------
  // odoo_search_count
  // -------------------------------------------------------------------------
  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK no-schema tool() overload signature mismatch
  (server.tool as any)(
    'odoo_search_count',
    async (args: unknown): Promise<ToolResult> =>
      executeHandler(
        'odoo_search_count',
        args,
        searchCountSchema,
        (parsed, context) => client.searchCount(parsed.model, parsed.domain as never[], context),
        logger,
        session,
      ),
  );
}
