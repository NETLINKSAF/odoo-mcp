# Configuration — @netlinksinc/odoo-mcp

Environment variables, Claude Desktop wiring, and security notes.

## Required environment variables

| Variable | Format | Example |
|----------|--------|---------|
| `ODOO_URL` | Full URL, no trailing slash | `https://my.odoo.example.com` |
| `ODOO_DB` | Non-empty string | `production` |
| `ODOO_USERNAME` | Odoo login (usually email) | `admin@example.com` |
| `ODOO_API_KEY` | Odoo API key string | `abc123def456...` |

All four are validated at startup via Zod. If any is missing or malformed, the process writes a JSON error to stderr and exits 1:

```json
{ "event": "config_error", "missing": ["ODOO_API_KEY"], "invalid": [] }
```

The error message lists variable **names only** — no values are logged.

`ODOO_URL` is normalized: a trailing slash is stripped before use.

## Optional environment variables

| Variable | Format | Default | Description |
|----------|--------|---------|-------------|
| `ODOO_MCP_LOG_FILE` | Absolute file path | (none) | Append structured JSON logs to this file. Created if absent; fails startup if the path is not writable. File is opened with mode `0600`. |
| `ODOO_MCP_DEBUG` | `"1"` | (unset) | When set to `"1"`, Python tracebacks from Odoo are included in tool error responses as the `traceback` field. Do not enable in production — tracebacks may contain internal Odoo paths. |

## Generating an Odoo API key

1. Log in to your Odoo instance as the user the connector will run as.
2. Go to **Settings → Users & Companies → Users** and open the user record.
3. In the **Account Security** tab, click **New API Key**.
4. Set a name (e.g. `odoo-mcp`) and leave scope as **All Access**.
5. Copy the key immediately — it is not shown again.

The connector cannot create API keys programmatically and does not support restricted-scope keys in v0. The key authenticates as the full user; apply appropriate Odoo security groups to the user instead of relying on key scope.

## Claude Desktop configuration

Add the following to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent path on your platform:

```json
{
  "mcpServers": {
    "odoo": {
      "command": "npx",
      "args": ["@netlinksinc/odoo-mcp"],
      "env": {
        "ODOO_URL": "https://your.odoo.example.com",
        "ODOO_DB": "your_database",
        "ODOO_USERNAME": "your_username",
        "ODOO_API_KEY": "your_api_key"
      }
    }
  }
}
```

The `npx` invocation downloads and runs the latest published version. Pin to a specific version for production:

```json
"args": ["@netlinksinc/odoo-mcp@0.1.0"]
```

Restart Claude Desktop after editing the config file.

## Security notes

**HTTP warning.** If `ODOO_URL` starts with `http://`, the server writes a warning to stderr at startup:

```json
{ "event": "warning", "message": "ODOO_URL uses http:// — credentials transmitted in plaintext" }
```

The server continues to run — the warning is not fatal — but credentials and record data will be transmitted unencrypted. Use `https://` in all non-localhost environments.

**API key never logged.** The `ODOO_API_KEY` value is never written to stderr or the log file. The startup log line records only `odoo_url`, `odoo_db`, and `odoo_username`.

**Tracebacks gated on DEBUG.** Python tracebacks from Odoo are suppressed in tool error responses unless `ODOO_MCP_DEBUG=1`. Tracebacks may expose internal Odoo class paths and database structure.

**PII redaction.** Tool args passed to the logger are sanitized before writing. Any value whose key matches `/password|credit_card|token|secret|api_key/i` is replaced with `[REDACTED]`. This applies to `odoo_create`, `odoo_write`, `odoo_execute`, and `odoo_call_action`; other tools skip the clone and traversal overhead since they do not accept credential-shaped fields.

## Multi-company behavior

Every tool accepts `allowed_company_ids` and `active_company_id`. These are validated before the RPC call:

- Every ID in `allowed_company_ids` must be present in `session.allowedCompanyIds` (the set returned at authentication time). Passing an ID outside this set yields `InputValidationError`.
- `active_company_id` is applied to `company_id` in the RPC context.
- If either field is omitted, the session defaults are used.

The session-authoritative fields (`uid`, `company_id`, `allowed_company_ids`) are always re-applied **after** any caller-supplied context, so a caller cannot override the authenticated identity via the `context` argument on `odoo_call_action`.

See [tools reference](./tools.md) for per-tool schema details and [troubleshooting](./troubleshooting.md) for the `InputValidationError: company ID not in session` error.
