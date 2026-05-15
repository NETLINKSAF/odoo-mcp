# odoo-mcp

Odoo 19 MCP server. Lets Claude run agentic workflows on any Odoo instance.

**v0.1.0** — MIT — Published as `@netlinks/odoo-mcp` on npm (planned). Maintained by NETLINKS.

---

## Quick start

```bash
ODOO_URL=https://your.odoo.example.com \
ODOO_DB=your_db \
ODOO_USERNAME=mcp_user \
ODOO_API_KEY=your_api_key \
npx @netlinks/odoo-mcp
```

---

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `ODOO_URL` | yes | Full URL to the Odoo instance. `http://` triggers a plaintext warning to stderr. |
| `ODOO_DB` | yes | Odoo database name. |
| `ODOO_USERNAME` | yes | Login of the Odoo user; security groups on this user determine accessible records. |
| `ODOO_API_KEY` | yes | API key generated in Odoo (Settings → Users → API Keys). |
| `ODOO_MCP_LOG_FILE` | no | Optional path; structured JSON log lines go to stderr always, and additionally to this file if set. Created with 0o600 perms. |

---

## Claude Desktop setup

Add the following entry to your `claude_desktop_config.json` (on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odoo": {
      "command": "npx",
      "args": ["@netlinks/odoo-mcp"],
      "env": {
        "ODOO_URL": "<your-odoo-url>",
        "ODOO_DB": "<db-name>",
        "ODOO_USERNAME": "<user>",
        "ODOO_API_KEY": "<api-key>"
      }
    }
  }
}
```

A copy-paste version is in `examples/claude-desktop-config.json`.

---

## Tools

10 MCP tools are registered. All tools accept optional `allowed_company_ids` and `active_company_id` for multi-company control (see below).

| Tool | Description |
|------|-------------|
| `odoo_search_read` | Search + read records in one call. Default limit 80. |
| `odoo_read` | Read specific record IDs. |
| `odoo_create` | Create one or many records. |
| `odoo_write` | Update existing records. |
| `odoo_unlink` | Delete records. |
| `odoo_search_count` | Count records matching a domain. |
| `odoo_execute` | Call any model method (`execute_kw`). Model + method validated against strict regex. |
| `odoo_run_report` | Render a QWeb PDF report and return base64. |
| `odoo_call_action` | Call a named server action (method) on a model. |
| `odoo_fields_get` | Introspect model schema. |

---

## Resources

7 MCP resources are populated at startup by a capability probe:

| URI | Content |
|-----|---------|
| `odoo://modules` | Installed modules list. |
| `odoo://reports` | Available QWeb reports. |
| `odoo://server-actions` | Registered server actions. |
| `odoo://companies` | Companies accessible to the session user. |
| `odoo://currencies` | Active currencies. |
| `odoo://fiscal-year` | Current fiscal year dates. |
| `odoo://user-context` | Session context (lang, tz, uid, etc.). |

Claude reads these at startup to understand what the Odoo instance has installed and what it can operate on.

---

## Multi-company

Every tool accepts optional `allowed_company_ids` and `active_company_id` parameters. These are validated against the companies the session user has access to — the caller cannot escape session scope. If omitted, the session defaults apply.

---

## Customization

The tool surface is intentionally generic. There are no per-module tools. This means it works equally well on any Odoo module — including custom modules that didn't exist when this server was written. The capability resources at `odoo://...` tell Claude what is installed so it can adapt its behavior at runtime.

---

## Logging and debugging

Structured JSON log lines are written to stderr unconditionally. Set `ODOO_MCP_LOG_FILE` to also write them to a file (created with 0o600 permissions). Set `ODOO_MCP_DEBUG=1` to include Odoo Python tracebacks in error responses — useful during development but avoid in production since tracebacks may reveal model internals.

---

## License

MIT - 2026 NETLINKS
