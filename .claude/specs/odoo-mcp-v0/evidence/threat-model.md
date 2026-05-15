## Threat Model: odoo-mcp-v0

### STRIDE Analysis

| Component | S | T | R | I | D | E |
|-----------|---|---|---|---|---|---|
| OdooClient | Stolen API key allows impersonation of Odoo user | MITM on HTTP (non-TLS) can modify RPC payloads | No audit trail beyond structured log | API key in memory could leak via process dump | Odoo server unavailability blocks all operations | `execute_kw` allows arbitrary method invocation on any model |
| Auth Strategy | API key transmitted in plaintext if ODOO_URL is HTTP | Session cookie tampering if cookie-auth path used | - | API key or session cookie stored in memory unencrypted | Auth fallback loop could hang on partial Odoo response | - |
| JSON-RPC Transport | - | Unsigned JSON-RPC payloads tampered in transit on HTTP | - | Full RPC response tracebacks may contain internal server paths | Missing request timeout allows hung connections | - |
| MCP Server Factory | - | - | - | - | Uncaught exception crashes entire stdio server | - |
| Config Loader | - | Env var injection by parent process | - | API key could be logged during validation error output | - | - |
| Capability Probe | - | Stale probe results served if Odoo data changes post-startup | - | Probe results reveal internal Odoo module/action inventory | Probe timeout stalls server startup | - |
| Resource Publisher | - | - | - | Cached probe data served to any MCP client without scoping | - | - |
| Tool Handlers | - | Unsanitized model/method names in `execute_kw` could invoke unintended methods | Tool calls logged but log tampering possible | Large `search_read` results may contain PII in field values | Unbounded `args`/`kwargs` could send very large payloads | `odoo_execute` arbitrary method invocation bypasses ORM safety rails |
| Multi-Company Context Builder | Claude could supply `allowed_company_ids` for inaccessible companies | Context dict merge could overwrite security-sensitive keys | - | - | - | Forged `active_company_id` could access cross-company data if Odoo record rules misconfigured |
| Logger | - | Log file writable by other processes could be tampered | - | PII redaction regex may miss custom sensitive field names | Log file on full disk could cause write errors | - |
| MCP Error Formatter | - | - | - | Odoo tracebacks in ServerError expose internal file paths, DB schema | - | - |

### Trust Boundaries

| Boundary | Components | Data | Protection |
|----------|-----------|------|------------|
| MCP stdio transport | Claude Desktop/Code <-> MCP Server Factory | MCP JSON messages (tool calls, results, resources) | Host OS process isolation; no network listener; trust boundary is the local machine |
| JSON-RPC to Odoo | OdooClient <-> Odoo 19 Instance | JSON-RPC requests/responses (credentials, ORM data, tracebacks) | HTTPS/TLS (when ODOO_URL uses https); API key authentication; Odoo ACLs |
| Environment to Config | Host OS environment <-> Config Loader | ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY | OS-level env var access control; no encryption at rest |
| Logger to filesystem | Logger <-> Log file | Sanitized tool call records, startup/shutdown events | File system permissions (OS-level) |

### Attack Surface
- Entry points: 10 MCP tool handlers (search_read, read, create, write, unlink, search_count, execute, run_report, call_action, fields_get), MCP resource reads (7 probe resources), CLI entry via `npx @netlinks/odoo-mcp`
- Data stores: In-memory ProbeResult cache, in-memory OdooSession, optional log file on disk
- External integrations: Odoo 19 JSON-RPC endpoint (HTTP/HTTPS), npm registry (install-time)
- Admin interfaces: None (no HTTP listener, no debug endpoints, no admin API)

### Injected Criteria

1. [threat-model] THE SYSTEM SHALL NOT include the value of `ODOO_API_KEY` in any stderr output, structured error message, or process exit message during configuration validation failure (US-1, severity: HIGH)
2. [threat-model] WHEN `ODOO_URL` uses the `http://` scheme (non-TLS) WHEN the server starts THE SYSTEM SHALL emit a structured warning to stderr indicating that credentials will be transmitted in plaintext (US-2, severity: HIGH)
3. [threat-model] THE SYSTEM SHALL validate that `model` parameters match the pattern `^[a-z][a-z0-9_.]*$` and `method` parameters match `^[a-z_][a-z0-9_]*$` before passing them to Odoo `execute_kw` (US-5, severity: HIGH)
4. [threat-model] THE SYSTEM SHALL NOT include Odoo tracebacks in MCP tool error payloads for any error type other than development-mode opt-in; the `traceback` field SHALL be omitted unless `ODOO_MCP_DEBUG=1` is set (US-8, severity: HIGH)
5. [threat-model] THE SYSTEM SHALL set a request timeout of 30 seconds on all JSON-RPC HTTP calls to the Odoo instance and return an MCP tool error with `error_type: "ConnectionError"` if the timeout is exceeded (US-8, severity: MEDIUM)
6. [threat-model] WHEN all capability probe sub-queries fail WHEN the server starts THE SYSTEM SHALL log a structured warning and populate every resource with an error payload; THE SYSTEM SHALL NOT serve empty arrays as if they were valid probe results (US-3, severity: MEDIUM)
7. [threat-model] THE SYSTEM SHALL NOT allow caller-provided `context` to override the keys `uid`, `allowed_company_ids`, or `company_id` in the merged Odoo RPC context (US-7, severity: MEDIUM)
8. [threat-model] THE SYSTEM SHALL ship with a `pnpm-lock.yaml` lockfile committed to the repository and THE SYSTEM SHALL NOT define `preinstall`, `install`, or `postinstall` lifecycle scripts in any `package.json` (US-10, severity: MEDIUM)
9. [threat-model] WHEN `ODOO_MCP_LOG_FILE` is set THE SYSTEM SHALL create the log file with permissions `0o600` (owner read/write only) if it does not already exist (US-9, severity: MEDIUM)
10. [threat-model] WHEN a tool call includes `allowed_company_ids` containing a company ID not present in the session's `allowedCompanyIds` THE SYSTEM SHALL return an MCP tool error with `error_type: "InputValidationError"` before sending any RPC call to Odoo (US-7, severity: MEDIUM)
