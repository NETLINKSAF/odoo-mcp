# Architecture — @netlinks/odoo-mcp

Internal design for contributors. Covers package split, data flow, probe design, and key invariants.

## Two-package split

```
packages/
  odoo-client/   -- @netlinks/odoo-client
  odoo-mcp/      -- @netlinks/odoo-mcp
```

`odoo-client` is a standalone JSON-RPC client with zero MCP dependency. It can be imported directly by any Node.js application that needs to talk to Odoo 19. `odoo-mcp` imports `odoo-client` and wraps it in an MCP stdio server.

The split exists for two reasons:

1. **Reuse.** Teams running Odoo integrations that do not involve Claude can use `odoo-client` without pulling in the MCP SDK.
2. **Testability.** `odoo-client` is tested against a mock fetch surface; `odoo-mcp` is tested by injecting a mock `OdooClient` and mock session, decoupled from the HTTP layer.

## Module import graph

```
bin.ts
  -> config.ts          (loads + validates env)
  -> server.ts          (wires subsystems)
       -> logger.ts     (createLogger)
       -> probe.ts      (runProbe)
       |    -> @netlinks/odoo-client (OdooClient methods)
       -> resources.ts  (registerResources -- closes over probe snapshot)
       -> tools/index.ts
            -> tools/orm.ts         (6 ORM tools)
            -> tools/execute.ts     (odoo_execute)
            -> tools/report.ts      (odoo_run_report)
            -> tools/action.ts      (odoo_call_action)
            -> tools/introspect.ts  (odoo_fields_get)
            -> tools/schemas.ts     (Zod schemas, MODEL_NAME, METHOD_NAME)
            -> context.ts           (buildContext, validateCompanySubset)
            -> errors.ts            (formatMcpError)

@netlinks/odoo-client index.ts
  -> types.ts    (Domain, Context, OdooRecord, OdooConfig, OdooSession, ...)
  -> errors.ts   (OdooError hierarchy)
  -> rpc.ts      (jsonRpc, REQUEST_TIMEOUT_MS, JsonRpcRequest, JsonRpcResponse)
  -> auth.ts     (AuthStrategy, ApiKeyAuthStrategy, SessionCookieAuthStrategy, createAuthStrategy)
  -> client.ts   (OdooClient)
  -> sanitize.ts (sanitizeArgs)
```

## Startup sequence

`bin.ts` runs these steps in order:

1. `loadConfig()` — validates env vars; exits 1 on failure.
2. `createOdooMcpServer()`:
   a. `new OdooClient(config)` — no I/O.
   b. `client.authenticate()` — one HTTPS round-trip; throws `OdooAuthError` on failure, propagated to `bin.ts` which writes JSON to stderr and exits 1.
   c. `createLogger(logFile)` — opens the log-file fd once with mode `0600`.
   d. `runProbe(client)` — 7 sub-queries in parallel; never throws.
   e. `new McpServer(...)` — creates the MCP server instance.
   f. `registerResources(server, probe)` — registers 7 resources backed by the probe snapshot.
   g. `registerAllTools(server, client, session, logger)` — registers 10 tool handlers.
3. `logger.startup(...)` — logged before transport connect.
4. SIGTERM/SIGINT handlers registered.
5. `server.connect(new StdioServerTransport())` — blocks until transport closes.

## Probe design (7 promises, 8 fields)

`runProbe` fans out 7 `Promise.allSettled` sub-queries and maps results to the 8-field `ProbeResult` shape. The extra field comes from sub-query 7 (userContext), which provides both `language` and `locale`.

| # | Sub-query | Model | ProbeResult fields |
|---|-----------|-------|--------------------|
| 1 | modules | `ir.module.module` | `modules` |
| 2 | reports | `ir.actions.report` | `reports` |
| 3 | server actions | `ir.actions.server` | `serverActions` |
| 4 | companies | `res.company` | `companies` |
| 5 | currencies | `res.currency` | `currencies` |
| 6 | fiscal year | `account.fiscal.year` | `fiscalYear` |
| 7 | user context | `res.users.context_get()` | `language`, `locale` |

Sub-query 6 has an internal fallback: if `account.fiscal.year` raises `OdooMissingError` (model not installed) or returns no rows, a synthetic `YYYY-01-01 / YYYY-12-31` is returned using the current calendar year. This is the only sub-query that never reaches the `allSettled` rejection path for the missing-model case.

If all 7 promises reject, a JSON warning is written to stderr:

```json
{ "event": "warning", "message": "All probe sub-queries failed" }
```

## `buildContext` field-priority semantics

`buildContext(session, companyArgs, extraContext?)` merges in three layers:

```
session.userContext        <- lowest priority (base)
  + extraContext           <- caller-supplied (odoo_call_action only)
  + uid                   <- always from session (cannot be overridden)
  + allowed_company_ids   <- from companyArgs if set, else session
  + company_id            <- from companyArgs.active_company_id if set, else session
```

The authoritative identity fields are applied last. A caller that passes `{ uid: 999 }` in `extraContext` has that value silently overwritten before the RPC call. This is intentional (US-5 AC-4 / US-7 AC-7).

## Logging

- **stdout is reserved** for MCP stdio transport (JSON-RPC framing). Nothing else may write to stdout.
- **stderr** receives all log output as newline-delimited JSON objects.
- **Log file** (optional): when `ODOO_MCP_LOG_FILE` is set, the same lines are appended to the file (opened once with `O_APPEND | O_CREAT`, mode `0600`). No per-write open/close.

Log event shapes:

```json
{ "ts": "...", "event": "startup", "odoo_url": "...", "odoo_db": "...", "odoo_username": "..." }
{ "ts": "...", "event": "tool_call", "tool": "odoo_search_read", "args_sanitized": {...}, "latency_ms": 42, "status": "ok" }
{ "ts": "...", "event": "tool_call", "tool": "odoo_create", "args_sanitized": {...}, "latency_ms": 11, "status": "error", "error": "ValidationError" }
{ "ts": "...", "event": "shutdown" }
```

`args_sanitized` has PII-shaped values redacted (see `sanitizeArgs` in [api-reference](./api-reference.md)).

## Error mapping: Odoo Python → MCP tool response

```
odoo.exceptions.AccessDenied   -> OdooAuthError     -> error_type: "OdooAuthError"
odoo.exceptions.UserError       -> OdooUserError     -> error_type: "UserError"
odoo.exceptions.ValidationError -> OdooValidationError -> error_type: "ValidationError"
odoo.exceptions.AccessError     -> OdooAccessError   -> error_type: "AccessError"
odoo.exceptions.MissingError    -> OdooMissingError  -> error_type: "MissingError"
(unrecognized)                  -> OdooError         -> error_type: "ServerError"
(non-OdooError thrown in handler) -> (caught by F-005 guard) -> error_type: "InternalError"
InputValidationError (Zod)      -> (no OdooError)   -> error_type: "InputValidationError"
```

`formatMcpError` maps an `OdooError` to the `McpToolError` shape. The `traceback` field is only populated when `ODOO_MCP_DEBUG=1`.

## Why `server.tool` no-schema overload

The MCP SDK's schema-overload for `server.tool(name, schema, cb)` throws `McpError` on validation failure, which the SDK translates to a protocol-level error — not a tool-level `isError: true` response. The spec requires `InputValidationError` to appear as a tool result with `isError: true` so Claude can read and reason about it.

To achieve this, all tool handlers use the two-argument overload `server.tool(name, cb)` and perform their own `schema.safeParse(args)` internally, returning `{ isError: true, content: [{ type: 'text', text: '...' }] }` on failure.

The ORM tools (`orm.ts`) use a type assertion (`server.tool as any`) because the two-argument overload's TypeScript signature expects `args` typed as a Zod inferred type matching a registered schema, not `unknown`. This is a known SDK typing limitation.

## Auth strategy fallback chain

```
createAuthStrategy(config)
  1. Try ApiKeyAuthStrategy.authenticate(config)
     -> if OdooAuthError: try SessionCookieAuthStrategy.authenticate(config)
     -> if any other error: rethrow
  2. Return the strategy that succeeded
```

The fallback to `SessionCookieAuthStrategy` handles Odoo instances where API-key auth is disabled or the key format is rejected. In practice, `ApiKeyAuthStrategy` sends the API key as the `password` field in the standard authenticate call, which works on all Odoo 19 instances with API keys enabled.
