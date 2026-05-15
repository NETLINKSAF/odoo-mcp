# Release: `@netlinks/odoo-mcp` v0.1.0

Initial release of the Odoo 19 MCP connector. Lets Claude run agentic workflows on any Odoo instance through a generic-only tool surface (works on stock and customized modules, including custom models that didn't exist when this connector was written).

## Highlights

- **2 npm packages**: `@netlinks/odoo-client` (standalone TypeScript JSON-RPC client) and `@netlinks/odoo-mcp` (the MCP server binary, `odoo-mcp`)
- **10 MCP tools**: full ORM (`search_read`, `read`, `create`, `write`, `unlink`, `search_count`) + generic invocation (`execute`, `run_report`, `call_action`) + introspection (`fields_get`)
- **7 MCP resources**: `odoo://modules`, `odoo://reports`, `odoo://server-actions`, `odoo://companies`, `odoo://currencies`, `odoo://fiscal-year`, `odoo://user-context` — populated once by the startup capability probe, served from memory thereafter
- **Multi-company aware**: every tool accepts `allowed_company_ids` and `active_company_id`; validated against the authenticated user's session, no override possible
- **Threat-modeled**: regex-validated model/method names on every tool, PII redaction in logs, traceback only on `ODOO_MCP_DEBUG=1`, no API key value ever surfaces in error output, http:// URLs emit a stderr warning at startup

## Changelog

This is the first public release; the entire codebase is "new". The list below is what landed across waves 0–7 of the build:

### Foundation (waves 0–1)

- Workspace scaffolding (pnpm + Biome + Vitest + tsc strict, Node 22+, ESM, `module: Node16`)
- Two-package split with workspace symlinks (`@netlinks/odoo-client` consumed by `@netlinks/odoo-mcp`)
- Shared type contracts: `OdooConfig`, `OdooSession`, `Domain`, `Context`, `OdooRecord`, `CompanyContext`, `ProbeResult`
- Seven typed error classes mapped 1:1 to Odoo Python exceptions (`OdooError`, `OdooAuthError`, `OdooUserError`, `OdooValidationError`, `OdooAccessError`, `OdooMissingError`, `OdooConnectionError`)
- `jsonRpc()` transport with 30-second timeout (`REQUEST_TIMEOUT_MS`), automatic fault → error mapping, no headers field in the request envelope (cookie injection happens via the headers arg)
- PII sanitizer: deep redaction of `password`, `credit_card`, `token`, `secret`, `api_key` keys before logging

### Authentication and client (waves 2–3)

- `ApiKeyAuthStrategy` (preferred) + `SessionCookieAuthStrategy` (fallback) implementing a shared `AuthStrategy` interface
- `createAuthStrategy()` factory tries API key first, falls back to cookie on `OdooAuthError`
- `http://` URL detection emits structured stderr warning before any RPC call (US-2 AC-5)
- `OdooClient` class: 10 methods (auth + 6 ORM + execute + runReport + callAction + fieldsGet) all guarded by `requireSession()`
- `loadConfig()`: Zod-validated env-var parsing with strict guard against leaking `ODOO_API_KEY` value into config-error stderr output
- Structured logger: stderr always, optional file with `0o600` perms, fixed key set on `startup` event to prevent api_key key from ever appearing
- `formatMcpError()`: maps `OdooError` → `McpToolError` with traceback gated on `ODOO_MCP_DEBUG=1`
- `buildContext()` + `validateCompanySubset()`: three-layer context merge that re-applies session-authoritative `uid` / `allowed_company_ids` / `company_id` *after* caller-supplied context — caller cannot override identity
- Zod schemas for all 10 tool inputs (`MODEL_NAME` regex `^[a-z][a-z0-9_.]*$` on `model`, `METHOD_NAME` regex `^[a-z_][a-z0-9_]*$` on `method` / `action_name`)

### MCP tool surface (waves 4–5)

- 6 ORM tool handlers (`registerOrmTools`) sharing a single `executeHandler` helper
- `odoo_execute` (registerExecuteTool), `odoo_run_report` (registerReportTool), `odoo_call_action` (registerActionTool), `odoo_fields_get` (registerIntrospectTool)
- `runProbe()`: 7 parallel sub-queries via `Promise.allSettled` mapped to 8 `ProbeResult` fields. Fiscal year falls back to synthetic current year on `OdooMissingError`. Total failure writes a stderr warning, never throws
- `registerResources()`: publishes 7 capability resources, each a closure over the pre-fetched probe field; returns `{ error: "..." }` content when a probe field failed (no MCP error response, no empty array)
- `registerAllTools()`: single aggregation point that wires the 5 register functions into the MCP server

### Server + CLI (wave 6)

- `createOdooMcpServer(config)`: returns `{ server, logger }` so `bin.ts` can share the same logger fd
- `bin.ts`: `#!/usr/bin/env node` entry, top-level try/catch serializes startup errors to stderr + exits 1, SIGTERM/SIGINT handlers registered before `server.connect` blocks
- Auth-error propagation: `OdooAuthError` flows uncaught from `createOdooMcpServer` to `bin.ts`'s top-level catch (US-2 AC-3)

### Smoke test, docs, packaging (wave 7)

- `scripts/smoke-test.mjs`: manual MCP JSON-RPC stdio harness with 30-second overall timeout (not wired to CI per design)
- `README.md` (115 lines, direct voice, no padding)
- `examples/claude-desktop-config.json`
- `docker-compose.yml` for future integration testing (Odoo 19 CE + Postgres 16)

### v0.1 hardening (post-acceptance)

- Schema-layer regex enforcement applied to ALL tool schemas (previously only inline in `execute.ts`)
- `sanitizeArgs` extended to `odoo_execute` + `odoo_call_action` with generic deep-traversal
- `logger.toolCall` now fires on every validation early-return (was missing in 4 handlers)
- Non-`OdooError` exceptions caught + logged as `error_type: "InternalError"` and returned as `isError: true` (was re-thrown to the MCP SDK, creating monitoring blind spots)
- Dead-code removal: `OdooClient.probe()` deleted, single probe path via `runProbe()`
- JSDoc on the public error/auth/transport/sanitizer surface (doc coverage ~75%, up from ~56%)
- Named constants: `REQUEST_TIMEOUT_MS`, `DEFAULT_SEARCH_LIMIT`, `MODULE_PROBE_LIMIT`

## Breaking changes

None. This is the initial release; there is no prior public version to break.

## Deployment checklist

### Pre-deployment

- [ ] On the Odoo side: create a dedicated `mcp_user` Odoo account with the security groups needed for the workflows you want Claude to run. Avoid using a real human's account.
- [ ] Generate an API key in **Settings → Users → API Keys** (note: Odoo only allows all-access keys; restricted keys are an Odoo roadmap item, not a connector feature)
- [ ] Decide on a log destination: stderr only (no `ODOO_MCP_LOG_FILE`) or a writable path (perms will be set to `0o600` on creation)
- [ ] Verify the Odoo URL is reachable from wherever Claude Desktop / Claude Code runs. The connector itself is local-process, so it inherits the host's network access
- [ ] Prefer `https://` URLs; `http://` triggers a stderr warning at startup but is not blocked

### Deploy via Claude Desktop

1. `npm install -g @netlinks/odoo-mcp` (or use `npx`, see Claude Desktop config below)
2. Edit `claude_desktop_config.json` (location varies by OS — see Anthropic's MCP docs):
   ```json
   {
     "mcpServers": {
       "odoo": {
         "command": "npx",
         "args": ["@netlinks/odoo-mcp"],
         "env": {
           "ODOO_URL": "https://your.odoo.example.com",
           "ODOO_DB": "your_database",
           "ODOO_USERNAME": "mcp_user",
           "ODOO_API_KEY": "your_api_key"
         }
       }
     }
   }
   ```
3. Restart Claude Desktop. The Odoo server should appear in the MCP server list with 10 tools and 7 resources.

### Smoke test

Manual only:

```bash
ODOO_URL=... ODOO_DB=... ODOO_USERNAME=... ODOO_API_KEY=... \
  node packages/odoo-mcp/dist/bin.js
```

Or use `scripts/smoke-test.mjs` (drives the full MCP initialize + tools/list handshake).

### Post-deployment

- [ ] Confirm `event: "startup"` line in stderr / log file shows your `odoo_url`, `odoo_db`, `odoo_username` (and crucially, NO `api_key` field — that's a hard rule)
- [ ] Drive one simple read tool from Claude (e.g. `odoo_search_read` on `res.partner`) to confirm the auth + probe flow worked
- [ ] If anything is wrong: set `ODOO_MCP_DEBUG=1` and restart — Odoo Python tracebacks will appear in MCP error responses

## Environment variables

| Name | Required | Notes |
|---|---|---|
| `ODOO_URL` | yes | https://hostname[:port][/path], trailing slash auto-stripped |
| `ODOO_DB` | yes | Odoo database name |
| `ODOO_USERNAME` | yes | Login of the Odoo user |
| `ODOO_API_KEY` | yes | Generated in Odoo Settings → API Keys |
| `ODOO_MCP_LOG_FILE` | no | Optional path; file created with `0o600` perms |
| `ODOO_MCP_DEBUG` | no | Set to `1` to include Odoo Python tracebacks in error responses |

## Database migrations

None. The connector is a read/write client to an existing Odoo instance — it has no internal database, no migrations, no state directory. Treat the Odoo instance as the database; the connector is stateless beyond the in-memory session and probe snapshot.

## Rollback plan

The connector runs as a Claude Desktop / Claude Code MCP subprocess. To roll back:

1. Edit `claude_desktop_config.json` and remove the `"odoo"` entry from `mcpServers`. Restart Claude Desktop. The MCP server stops spawning.
2. If pinned to a specific version: `npx -y @netlinks/odoo-mcp@<previous-version>` in the config's `args` array.
3. No Odoo-side cleanup needed — the connector creates no data and writes only via the audit-trailed user account used for auth.
4. Log files (if `ODOO_MCP_LOG_FILE` was set) persist on disk and can be deleted manually.

If a tool call wrote data to Odoo that you want to undo, use the Odoo UI or `odoo_unlink` from Claude to remove it. There is no built-in transaction log in v0.1.

## Reproducibility manifest

| | |
|---|---|
| Spec name | `odoo-mcp-v0` |
| Spec phase at release | `documented` |
| Git SHA at spec init | `2a0d8efa` |
| Git SHA at release | `815c2426` |
| Commits in range | 22 |
| spec-engine plugin version | 2.0.0 |
| Build toolchain | pnpm + Biome 1.9 + Vitest 3 + TypeScript 5.7 (strict, Node16 modules, ES2022, ESM) |
| Runtime | Node ≥ 22 |
| Tests at acceptance | 253/253 (43 client + 210 mcp) |
| tsc errors | 0/0 |
| Security findings | 0 critical, 0 high outstanding, 2 medium accepted-by-design (F-006 domain validation, Wave-6 F-001 URL in stderr) |
| Spec file SHA256 (requirements.md) | `7cc6dfb2951792142f88dc8337bb4dd1673ea79ec9c0af5489481ef39a27718f` |
| Spec file SHA256 (design.md) | `5d6549679d9039eafc4d871d50aadff9deaef892a5ab4af94ce1a2a4c0c4aee6` |
| Spec file SHA256 (tasks.md) | `579a0bc5d73472f28ce29211cadb2acbc3bba78ff6391ab3a880639b208ac1e3` |

## Known limitations (deferred to v0.2+)

- **No retry/backoff on transient RPC failures.** A flaky Odoo HTTP layer surfaces immediately as `OdooConnectionError`. Add a small retry policy if you see false positives in practice.
- **No transcript / history surface.** Claude sees only the current session's responses; there is no log of what it has already asked.
- **Smoke test is manual-run only.** No CI wiring. Integration tests against a live Odoo (via `docker-compose.yml`) are out of scope for v0.1.
- **Doc coverage ~75%.** The `OdooClient` method-level JSDoc and a few internal types remain. Library is usable; reference is in `docs/api-reference.md`.
- **Odoo API keys are all-access.** Restricted-scope keys are an Odoo roadmap feature, not something this connector can request.

## Next steps in the spec-engine pipeline

- `/spec-engine:spec-verify` — post-deployment smoke against a live environment (if you stand up the docker-compose setup)
- `/spec-engine:spec-retro` — retrospective: what worked, what would be different next time

When ready for npm:

```bash
pnpm -r build
pnpm publish --filter @netlinks/odoo-client
pnpm publish --filter @netlinks/odoo-mcp
```

Requires an npm token with publish rights on the `@netlinks` scope.
