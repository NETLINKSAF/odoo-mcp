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

## Claude Desktop quick install

**Prereqs.** Node 22+ on your PATH (`node --version`). Claude Desktop installed. An Odoo 19 instance you can reach from your machine.

### 1. Get an Odoo API key

In your Odoo instance: **Settings → Users & Companies → Users → pick a user → Account Security → New API Key**. Name it `claude-desktop`, copy the key once shown — you won't see it again. The user's security groups in Odoo determine what Claude will be able to read and write.

If you want a clean audit trail, create a dedicated `mcp_user` Odoo user first and use its key, not your own.

### 2. Find your Claude Desktop config file

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

If the file doesn't exist yet, create it with `{}` as initial content.

### 3. Add the Odoo MCP server entry

Open the config file and add an `odoo` entry under `mcpServers`. If you already have other MCP servers, merge — don't replace the file:

```json
{
  "mcpServers": {
    "odoo": {
      "command": "npx",
      "args": ["-y", "@netlinks/odoo-mcp"],
      "env": {
        "ODOO_URL": "https://your.odoo.example.com",
        "ODOO_DB": "your_database",
        "ODOO_USERNAME": "mcp_user",
        "ODOO_API_KEY": "paste-the-key-from-step-1"
      }
    }
  }
}
```

The `-y` flag tells npx to auto-confirm the first-time download prompt. A copy-paste template lives at `examples/claude-desktop-config.json`.

### 4. Restart Claude Desktop

Fully quit (⌘Q on macOS — clicking the close button isn't enough) and reopen.

### 5. Verify

In a new conversation, click the slider/MCP icon in the input area. You should see **odoo** listed with **10 tools** and **7 resources**. Ask Claude something like:

> List the first 5 partners in Odoo.

Claude will call `odoo_search_read` on `res.partner` and return the results inline.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `odoo` doesn't appear in Claude Desktop | Config file JSON is invalid. Run `python3 -m json.tool < <path>` to validate |
| Tool calls hang for 30 s then fail with `ConnectionError` | `ODOO_URL` not reachable from your machine. Try `curl -I <url>` |
| `OdooAuthError` on first call | `ODOO_USERNAME` typo, `ODOO_API_KEY` revoked, or `ODOO_DB` doesn't exist |
| Everything works but tools never show up after `pnpm publish` | npx cache is stale — run `npx clear-npx-cache` or use a pinned version like `@netlinks/odoo-mcp@0.1.0` |
| Need to see Odoo's Python traceback | Add `"ODOO_MCP_DEBUG": "1"` to the `env` block and restart Claude Desktop |

Server log lines go to Claude Desktop's process log (Console.app on macOS, filter for `Claude`). For a dedicated log file, add `"ODOO_MCP_LOG_FILE": "/tmp/odoo-mcp.log"` to the `env` block.

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
