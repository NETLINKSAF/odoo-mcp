# Wave 6 Security Review — server factory + CLI entry

**Reviewer:** spec-security-reviewer (read-only)
**Date:** 2026-05-15
**Files reviewed:** `packages/odoo-mcp/src/server.ts`, `packages/odoo-mcp/src/bin.ts`
**Diff range:** `289f9bb..HEAD`

## Summary

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 1 (accepted as informational)
- LOW: 0

No blocking issues. No debugger dispatch.

## Findings

### [MEDIUM][ACCEPTED] F-001 — Connection error message could include ODOO_URL in stderr

- **Location:** `packages/odoo-mcp/src/bin.ts` (catch block, ~line 44)
- **Pattern:** `bin.ts` serializes `err.message` to stderr. `OdooConnectionError` carries the raw `fetch` error message which can include the request URL (e.g., `"request to https://odoo.example.com/web/session/authenticate failed"`).
- **Risk:** Surfaces the Odoo hostname in startup-failure logs. The URL itself is non-secret (credentials are in the POST body, not the URL) and is already logged at startup via `logger.startup({ odoo_url })` by design.
- **Disposition:** Accepted as informational. The URL is intentionally logged. No remediation.
- **Confidence:** 3/10

## Notes / accepted-by-design

1. **API key not in error messages.** `OdooAuthError` constructors use static or server-supplied strings; the API key value never reaches `err.message`. `bin.ts` only accesses `.message`, so the traceback field (which could carry the Python `password` arg from the Odoo stack) is NOT leaked. US-1 AC-6 holds.
2. **`logger.startup()` excludes `apiKey`.** `bin.ts:27-31` passes only `{ odoo_url, odoo_db, odoo_username }`. US-9 AC-2 satisfied.
3. **Signal-handler ordering correct.** SIGTERM/SIGINT handlers registered before `server.connect()` (the blocking call). Handlers call `logger.shutdown()` then `process.exit(0)`. US-10 AC-3 satisfied.
4. **No secrets, no injection vectors, no eval/exec, no SSRF, no auth gaps** in either file.
5. **Latent risk — full-error serialization.** If a future change were to do `JSON.stringify(err)` instead of `err.message`, the `traceback` field on auth errors WOULD expose the Odoo server's Python stack which can contain the `password` param. Currently safe; flag for code-review attention on future bin.ts changes.

## Cumulative security state

- Previous (post-wave-4): high: 6, medium: 12
- Wave 5: 0 new findings (skipped per audit log)
- Wave 6 adds: medium: 1 (accepted)
- New cumulative: high: 6, medium: 13
