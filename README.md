# odoo-mcp

Odoo 19 MCP server. Lets Claude run agentic workflows on any Odoo instance.

**v0.1.1** — MIT — Published as `@netlinksinc/odoo-mcp` on npm. Maintained by NETLINKS Inc.

## Client compatibility

| Client | v0.1.x (now) | v0.2 (next) |
|---|---|---|
| **Claude Code** (CLI) | ✓ supported | ✓ supported |
| **Claude Desktop** (newer "Add custom connector" UI) | not supported | ✓ via HTTP transport |
| **Claude Desktop** (older builds with `claude_desktop_config.json`) | may work (legacy stdio) | ✓ via HTTP transport |
| **Claude Cowork** | not supported | ✓ via HTTP transport |

v0.1.x is a **local stdio** MCP server — it runs as a subprocess of whatever spawned it. Today only Claude Code reliably supports that. v0.2 adds a streaming HTTP transport mode so the same binary can be deployed (Fly.io / Render / your VPS) and reached from any remote-MCP client including Claude Desktop's newer connector UI and Claude Cowork.

If you're on Claude Desktop or Cowork today and don't want to wait, [open an issue](https://github.com/farshidghyasi/odoo-mcp/issues) — happy to help bridge.

---

## Claude Code quick install

**Prereqs.** Node 22+ on your PATH, Claude Code installed, an Odoo 15+ instance you can reach.

### 1. Get an Odoo API key

In Odoo: top-right avatar → **Preferences** → **Account Security** → **New API Key**. Name it `claude-code`, click **Generate**, **copy the value immediately** — it's shown once.

The Odoo user's security groups determine what Claude can read and write. For a clean audit trail, create a dedicated `mcp_user` Odoo user first and use its key.

### 2. Add the MCP server to Claude Code

```bash
claude mcp add odoo --scope user \
  -e ODOO_URL=https://your.odoo.example.com \
  -e ODOO_DB=your_database \
  -e ODOO_USERNAME=your_username \
  -e ODOO_API_KEY=paste-the-key-from-step-1 \
  -- npx -y @netlinksinc/odoo-mcp
```

### 3. Verify

In a new `claude` session, type `/mcp`. You should see **odoo** listed with **✓ Connected**, 10 tools, and 7 resources.

### 4. Try it

```
> List 5 partners from Odoo.
```

Claude should call `odoo_search_read` on `res.partner` and return rows.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `odoo: ✗ Failed to connect` on `/mcp` | One of the env vars is wrong. Look at Claude Code's MCP logs |
| `OdooAuthError: Access Denied` | Wrong `ODOO_USERNAME`, revoked/typo'd `ODOO_API_KEY`, or wrong `ODOO_DB`. Verify by logging into the Odoo UI with the same login |
| `OdooConnectionError` | `ODOO_URL` not reachable from your machine. Try `curl -I <url>` |
| Tool calls hang then time out (30s) | Network path to Odoo is slow or being blocked. Check firewall / VPN |
| Need to see Odoo's Python traceback | Add `-e ODOO_MCP_DEBUG=1` to step 2 and re-add |

---

## Environment variables

| Name | Required | Description |
|------|----------|-------------|
| `ODOO_URL` | yes | Full URL to the Odoo instance. `http://` triggers a plaintext warning to stderr |
| `ODOO_DB` | yes | Odoo database name (Odoo.sh format: `<workspace>-<branch>-<id>`) |
| `ODOO_USERNAME` | yes | Login of the Odoo user (often email on Odoo.sh) |
| `ODOO_API_KEY` | yes | API key generated in Odoo Preferences → Account Security |
| `ODOO_MCP_LOG_FILE` | no | Optional path; structured JSON logs go to stderr always, also to this file if set. Created with `0o600` perms |
| `ODOO_MCP_DEBUG` | no | Set to `1` to include Odoo Python tracebacks in error responses |

---

## Tools

10 MCP tools are registered. All tools accept optional `allowed_company_ids` and `active_company_id` for multi-company control.

| Tool | Description |
|------|-------------|
| `odoo_search_read` | Search + read records in one call. Default limit 80 |
| `odoo_read` | Read specific record IDs |
| `odoo_create` | Create one or many records |
| `odoo_write` | Update existing records |
| `odoo_unlink` | Delete records |
| `odoo_search_count` | Count records matching a domain |
| `odoo_execute` | Call any model method (`execute_kw`). Model + method validated against strict regex |
| `odoo_run_report` | Render a QWeb PDF report and return base64 |
| `odoo_call_action` | Call a named server action (method) on a model |
| `odoo_fields_get` | Introspect model schema |

---

## Resources

7 MCP resources, populated at startup by a capability probe:

| URI | Content |
|-----|---------|
| `odoo://modules` | Installed modules list |
| `odoo://reports` | Available QWeb reports |
| `odoo://server-actions` | Registered server actions |
| `odoo://companies` | Companies accessible to the session user |
| `odoo://currencies` | Active currencies |
| `odoo://fiscal-year` | Current fiscal year dates |
| `odoo://user-context` | Session context (lang, tz, uid, …) |

Claude reads these at startup to understand what's installed on the Odoo instance.

---

## Multi-company

Every tool accepts optional `allowed_company_ids` and `active_company_id` parameters. These are validated against the companies the session user has access to — the caller cannot escape session scope. If omitted, session defaults apply.

---

## Customization

The tool surface is intentionally generic — no per-module tools. Works on any Odoo module, including custom modules that didn't exist when this server was written. The capability resources at `odoo://...` tell Claude what's installed so it can adapt at runtime.

---

## Logging and debugging

Structured JSON log lines go to stderr unconditionally. Set `ODOO_MCP_LOG_FILE` to also write them to a file (`0o600` perms). Set `ODOO_MCP_DEBUG=1` to include Odoo Python tracebacks in error responses — useful during development; avoid in production since tracebacks may reveal model internals.

---

## Roadmap

**v0.2** — adds a streaming HTTP transport mode (env var `MODE=http`), bearer-token auth, and a Fly.io deploy guide. Unlocks Claude Desktop's newer connector UI and Claude Cowork. Same npm package, same 10 tools, same 7 resources.

**v0.3** — multi-tenant OAuth 2.1 IdP. Hosted as a free service so any Cowork user can connect their own Odoo without self-deploying. Eligibility for Anthropic's connector directory.

---

## License

MIT — 2026 NETLINKS Inc.
