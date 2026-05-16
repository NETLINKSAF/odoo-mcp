# Troubleshooting — @netlinksinc/odoo-mcp

Common startup and runtime failures with specific causes and fixes.

## Startup: config_error — missing variables

**Symptom.** Server exits immediately. Stderr contains:

```json
{ "event": "config_error", "missing": ["ODOO_URL"], "invalid": [] }
```

**Cause.** One or more required environment variables are absent or empty.

**Fix.** Set all four required variables: `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY`. See [configuration](./configuration.md) for the full variable table. Verify the Claude Desktop config `env` block includes all four.

---

## Startup: OdooAuthError — credentials rejected

**Symptom.** Stderr contains:

```json
{ "event": "startup_error", "error_type": "OdooAuthError", "message": "Access Denied" }
```

**Causes and fixes:**

- `ODOO_USERNAME` typo or wrong login. Verify the exact login string — Odoo treats it as case-sensitive on some configurations.
- `ODOO_API_KEY` expired or revoked. Generate a new key in **Settings → Users → API Keys**.
- `ODOO_DB` does not exist on the target instance. Check the database name in the Odoo URL bar.
- The user account is archived. Unarchive or use a different account.

---

## Runtime: OdooConnectionError

**Symptom.** Tool returns `isError: true` with `error_type: "ConnectionError"`.

**Causes and fixes:**

- `ODOO_URL` points to a host that is unreachable or has a firewall blocking the port. Run `curl -I <ODOO_URL>/web` from the machine running the connector.
- DNS resolution failure. Verify the hostname resolves.
- TLS certificate error. The connector uses Node's native fetch; ensure the server's certificate chain is trusted by the system root store.
- Request took longer than 30 seconds (`REQUEST_TIMEOUT_MS`). The Odoo instance may be overloaded. Check Odoo worker logs.

---

## Runtime: OdooAccessError — permission denied on model

**Symptom.** Tool returns `error_type: "AccessError"`.

**Cause.** The authenticated Odoo user's security groups do not grant read/write/create/unlink permission on the target model or specific records.

**Fix.** Check the user's security groups in **Settings → Users**. Add the required group (e.g. `Sales / User`) or use a different account with broader permissions. Do not work around this by granting global access — use the minimal required group.

---

## Runtime: OdooMissingError — record no longer exists

**Symptom.** Tool returns `error_type: "MissingError"`.

**Cause.** A record ID was deleted or is not accessible to this user after another session modified it. Common in high-concurrency environments.

**Fix.** Re-query with `odoo_search_read` to get current IDs before operating on them. Do not assume IDs from earlier tool calls remain valid across sessions.

---

## Runtime: InputValidationError — model or method name rejected

**Symptom.** Tool returns `error_type: "InputValidationError"` with a message like `model must match /^[a-z][a-z0-9_.]*$/`.

**Cause.** `model` or `method` (on `odoo_execute` / `odoo_call_action`) contains characters outside the allowed set. Uppercase letters, hyphens, spaces, and shell-special characters are all rejected.

**Fix.** Use the technical Odoo model name (all lowercase, dots and underscores only), e.g. `res.partner`, `sale.order`, `account.move`. Method names use `snake_case` only, e.g. `action_confirm`, `action_post`.

---

## Startup warning: All probe sub-queries failed

**Symptom.** Server starts successfully but stderr contains:

```json
{ "event": "warning", "message": "All probe sub-queries failed" }
```

All 7 resources return `{ "error": "..." }`.

**Cause.** The authenticated user cannot access any of the 7 probe models (`ir.module.module`, `ir.actions.report`, `ir.actions.server`, `res.company`, `res.currency`, `account.fiscal.year`, `res.users`).

**Fix.** This usually means the user has an extremely restricted profile. Grant at minimum read access to `ir.module.module` and `res.company`, or use an account with broader access. The MCP tools themselves will still function if the user has model-level permissions — the probe failure only affects the read-only resources.

---

## Runtime: InternalError — unexpected exception

**Symptom.** Tool returns `error_type: "InternalError"` with `message: "unexpected error"`.

**Cause.** An exception that is not an `OdooError` subclass was caught in the tool handler. This is a bug or an unexpected runtime condition.

**Fix.** Enable debug mode to get more detail:

```json
"env": {
  "ODOO_MCP_DEBUG": "1",
  ...
}
```

Re-run the failing operation. The response will include a `detail` field with the raw error message. File a bug report with the full stderr output and tool invocation.

---

## Runtime: InputValidationError — company ID not in session

**Symptom.** Tool returns:

```json
{
  "error_type": "InputValidationError",
  "message": "InputValidationError: company ID not in session allowedCompanyIds: 5"
}
```

**Cause.** The tool call included `allowed_company_ids: [5]` but company 5 is not in the session's allowed set for this user. The session's `allowedCompanyIds` is determined at authentication time by Odoo.

**Fix.** Read `odoo://companies` to see which company IDs are available for the current session. Only pass IDs from that list. If the needed company is missing, the Odoo user must be granted access to that company in **Settings → Users → Companies**.

---

## Debug mode

Set `ODOO_MCP_DEBUG=1` to enable two behaviors:

1. Tool error responses include the `traceback` field containing the Python stack trace from Odoo.
2. The `detail` field is populated on `InternalError` responses.

Do not enable in production. Tracebacks may expose internal Odoo file paths and model structure. The API key is never included in debug output regardless of this flag.
