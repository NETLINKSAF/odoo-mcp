import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Context, OdooError, type OdooSession, sanitizeArgs } from '@netlinksinc/odoo-client';
import type { OdooClient } from '@netlinksinc/odoo-client';

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

/** Shape every tool handler funnels through after SDK-level Zod parsing. */
async function callOrm<T extends { allowed_company_ids?: number[]; active_company_id?: number }>(
  tool: string,
  args: T,
  exec: (parsed: T, context: Context) => Promise<unknown>,
  logger: Logger,
  session: OdooSession,
): Promise<ToolResult> {
  const t0 = Date.now();
  const rawArgs = args as unknown as Record<string, unknown>;
  try {
    if (args.allowed_company_ids) {
      validateCompanySubset(args.allowed_company_ids, session.allowedCompanyIds);
    }
    const context = buildContext(session, {
      allowed_company_ids: args.allowed_company_ids,
      active_company_id: args.active_company_id,
    });
    const result = await exec(args, context);
    logger.toolCall({
      tool,
      args_sanitized: sanitizeArgs(tool, rawArgs),
      latency_ms: Date.now() - t0,
      status: 'ok',
    });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    if (e instanceof OdooError) {
      const formatted = formatMcpError(e);
      logger.toolCall({
        tool,
        args_sanitized: sanitizeArgs(tool, rawArgs),
        latency_ms,
        status: 'error',
        error: formatted.error_type,
      });
      return { content: [{ type: 'text', text: JSON.stringify(formatted) }], isError: true };
    }
    // Non-OdooError — log + return InternalError shape (don't re-throw to MCP SDK)
    const message = e instanceof Error ? e.message : String(e);
    logger.toolCall({
      tool,
      args_sanitized: sanitizeArgs(tool, rawArgs),
      latency_ms,
      status: 'error',
      error: 'InternalError',
    });
    return {
      content: [
        {
          type: 'text',
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
}

/**
 * Register all 6 ORM tools on the MCP server using the 3-arg registerTool
 * overload that advertises the Zod input schema as JSON Schema in tools/list.
 *
 * Without inputSchema in the registration, MCP clients (Claude Code,
 * Claude Desktop, etc.) see an empty properties bag and strip every arg
 * before calling — making tools effectively unusable.
 */
export function registerOrmTools(
  server: McpServer,
  client: OdooClient,
  session: OdooSession,
  logger: Logger,
): void {
  server.registerTool(
    'odoo_search_read',
    {
      description:
        'Search and read records in one call. Returns matching rows up to `limit` (default 80).',
      inputSchema: searchReadSchema.shape,
    },
    async (args) =>
      callOrm(
        'odoo_search_read',
        args,
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

  server.registerTool(
    'odoo_read',
    {
      description: 'Read specific record IDs from a model. Returns one row per ID.',
      inputSchema: readSchema.shape,
    },
    async (args) =>
      callOrm(
        'odoo_read',
        args,
        (parsed, context) => client.read(parsed.model, parsed.ids, parsed.fields, context),
        logger,
        session,
      ),
  );

  server.registerTool(
    'odoo_create',
    {
      description:
        'Create one or many records. `values` may be a single dict or an array of dicts.',
      inputSchema: createSchema.shape,
    },
    async (args) =>
      callOrm(
        'odoo_create',
        args,
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

  server.registerTool(
    'odoo_write',
    {
      description: 'Update existing records. Applies `values` to every record in `ids`.',
      inputSchema: writeSchema.shape,
    },
    async (args) =>
      callOrm(
        'odoo_write',
        args,
        (parsed, context) => client.write(parsed.model, parsed.ids, parsed.values, context),
        logger,
        session,
      ),
  );

  server.registerTool(
    'odoo_unlink',
    {
      description: 'Delete records. Returns true on success.',
      inputSchema: unlinkSchema.shape,
    },
    async (args) =>
      callOrm(
        'odoo_unlink',
        args,
        (parsed, context) => client.unlink(parsed.model, parsed.ids, context),
        logger,
        session,
      ),
  );

  server.registerTool(
    'odoo_search_count',
    {
      description: 'Count records matching the domain. Returns an integer.',
      inputSchema: searchCountSchema.shape,
    },
    async (args) =>
      callOrm(
        'odoo_search_count',
        args,
        (parsed, context) => client.searchCount(parsed.model, parsed.domain as never[], context),
        logger,
        session,
      ),
  );
}
