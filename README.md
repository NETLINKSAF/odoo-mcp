# odoo-mcp

Odoo 19 MCP server. Lets Claude run agentic workflows on any Odoo instance.

**v0.2.1** — MIT — Published as `@netlinksinc/odoo-mcp` on npm. Maintained by NETLINKS Inc.

## Client compatibility

| Client | Transport | Auth | Status |
|---|---|---|---|
| **Claude Code** (CLI) | stdio | none (process-local) | Supported (v0.1+) |
| **Claude Desktop** ("Add custom connector" UI) | Streamable HTTP | OAuth 2.1 + PKCE | Supported (v0.2+, OAuth in v0.2.1+) |
| **Claude Cowork** | Streamable HTTP | OAuth 2.1 + PKCE | Supported (v0.2+, OAuth in v0.2.1+) |

The same `@netlinksinc/odoo-mcp` binary runs in two modes. `MODE=stdio` (default) is for Claude Code — it spawns the binary as a subprocess. `MODE=http` is for Claude Desktop's newer connector UI and Cowork — you deploy the binary yourself (Fly.io / Render / your VPS) and point your remote-MCP client at the URL.

**v0.2.1** replaces the single shared bearer token of v0.2.0 with OAuth 2.1 Authorization Code + PKCE. Each end-user authenticates with their own Odoo credentials and gets their own access token; tool calls execute under their per-user `OdooClient`. Stdio mode is unchanged.

## Self-host for Claude Desktop / Cowork

- **[docs/v0.2.1-oauth.md](docs/v0.2.1-oauth.md)** — v0.2.1 OAuth migration guide. New env vars, end-user flows for Claude Desktop (automatic) and Claude Code (manual `odoo-mcp auth` subcommand), admin allowlist, key rotation, revocation.
- **[docs/v0.2-deploy.md](docs/v0.2-deploy.md)** — deployment targets: Fly.io (canonical, ~5 minutes), Render, Railway, generic Linux VPS.

Multi-tenant by design: one deployment serves multiple end-users, each with their own Odoo credentials encrypted at rest under your server's `MCP_ENCRYPTION_KEY`. Allowlist-gated — only emails you explicitly `odoo-mcp users allow` can complete the OAuth dance.

The connector is intentionally self-hosted. NETLINKS does not run a hosted service. You hold your own encryption key, admin password, and end-users' encrypted Odoo credentials at deploy time; nothing is sent through any third-party connector service.

---

> ⚠️ **Read this first.** This connector gives Claude **direct read and write access** to your Odoo data — including the ability to `create`, `write`, and `unlink` records. Claude is an AI; it can misinterpret requests, hallucinate field names, or perform destructive operations you didn't intend. **Test against a development Odoo before pointing it at production**, and use a dedicated `mcp_user` with Odoo security groups scoped to only what you need. The maintainers accept no liability for data loss, business interruption, or any other harm — see the [Disclaimer](#disclaimer) section below.

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

Run `pnpm audit` from the repo root to check for known vulnerabilities in production dependencies.

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

**v0.2.1 (shipped)** — OAuth 2.1 Authorization Code + PKCE replaces the static bearer token. Per-user identity end-to-end: each end-user authenticates with their own Odoo credentials, gets their own access token, and tool calls execute under their per-user `OdooClient` via an `AsyncLocalStorage`-propagated `user_id`. Admin API (`/admin/users`) for the allowlist with admin-password auth + rate limiting. Encrypted credential store (AES-256-GCM, per-record IV, `chmod 0o600`); tokens stored as SHA-256 hashes only. CSRF protection on the consent form (HttpOnly + SameSite=Strict cookie + `timingSafeEqual`). Bundled CLI subcommands: `odoo-mcp users {list|allow|revoke}` + `odoo-mcp auth <url>`. Security posture: 99/100. Same 10 tools, same 7 resources.

**v0.2.0 (shipped)** — Streaming HTTP transport mode (env var `MODE=http`), static bearer-token auth (superseded by v0.2.1 OAuth), `/health` endpoint with proxy-aware redaction, Fly.io deploy guide, real-Odoo integration tests. Unlocked Claude Desktop's newer connector UI and Claude Cowork.

**Future (not committed)** — Possible additions based on user signal: support for Odoo 17/18 quirks, broader Odoo version coverage, additional self-host deploy recipes. A hosted-by-NETLINKS service is explicitly **not** on the roadmap — the connector is and will remain self-hosted (now multi-user-per-deployment).

---

## Disclaimer

This software is provided **AS IS**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. In no event shall NETLINKS Inc, the contributors, or any other party be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.

What this means in practice:

- **Data loss and modification.** Claude can call `odoo_unlink` to delete records, `odoo_write` to modify them, and `odoo_create` to add them. If you grant the connector access to a production Odoo instance and Claude performs a destructive operation, the responsibility is yours — set up appropriate Odoo security groups, audit trails, and backups before deploying.
- **Operational impact.** Claude may issue many RPC requests per query, especially `odoo_search_read` against large tables. Test query patterns against a development Odoo before exposing the connector to production workloads.
- **Information disclosure.** The connector transmits your Odoo data to Anthropic's Claude API as part of normal operation. Review Anthropic's data handling policy before connecting Odoo instances containing personal data, financial records, or regulated information.
- **No affiliation.** NETLINKS Inc is not affiliated with Anthropic, Odoo SA, or any of their subsidiaries. "Claude", "Anthropic", "Odoo", and related marks are the property of their respective owners.
- **Security.** Each end-user authenticates with their own Odoo API key (encrypted at rest under the server's `MCP_ENCRYPTION_KEY`). Each key has the same permissions as the Odoo user who created it. Use dedicated, scope-limited Odoo users for each MCP-end-user rather than personal or admin accounts. In v0.2.0 stdio deployments a single shared API key was used; v0.2.1 HTTP mode is per-user.
- **Legal review.** This README is not legal advice. If you intend to deploy this connector in a regulated environment (healthcare, financial services, EU GDPR-sensitive data), consult your own counsel before doing so.

The full license is at `LICENSE`. By using this software you agree to the terms of the MIT License and this disclaimer.

---

## License

MIT — 2026 NETLINKS Inc.
