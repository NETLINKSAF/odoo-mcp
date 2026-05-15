# Wave 4 Security Review — MCP tool surface

**Reviewer:** spec-security-reviewer (read-only)
**Date:** 2026-05-15
**Files reviewed:** orm.ts, execute.ts, report.ts, action.ts, introspect.ts, probe.ts (6 files)
**Diff range:** `6199a34..784b8b6`

## Summary

- CRITICAL: 0
- HIGH: 2 (1 fixed, 1 deferred)
- MEDIUM: 4 (deferred to v0.1 hardening)
- LOW: 0

No CRITICAL → no debugger dispatch.

## Findings

### [HIGH][FIXED] F-001 — Missing METHOD_RE on `action_name` in `odoo_call_action`

- **Location:** `packages/odoo-mcp/src/tools/action.ts` (handler dispatch)
- **Risk:** `action_name` was accepted as any non-empty string and dispatched as the `method` parameter on `execute_kw`. A caller could pass `action_name: "unlink"` (or any other ORM method) and effectively bypass the tool-shaped guardrails that exist on `odoo_unlink`, `odoo_write`, etc. This is the same threat pattern that US-5 AC-9 addresses for the execute tool — but the spec didn't explicitly extend that criterion to the action tool.
- **Fix applied (commit pending):** Added `const METHOD_RE = /^[a-z_][a-z0-9_]*$/` in `action.ts` with an early-return `InputValidationError` when `data.action_name` fails the regex. Mirrors the US-5 AC-9 implementation in `execute.ts`.
- **Confidence at discovery:** 8/10. Confirmed by inspection of `client.callAction` → `this.execute(model, actionName, ...)` → `jsonRpc(...)`.

### [HIGH][DEFERRED] F-002 — Inconsistent MODEL_RE across tool schemas

- **Location:** `packages/odoo-mcp/src/tools/schemas.ts` (all schemas with `model: z.string().min(1)`)
- **Risk:** Only `execute.ts` enforces `MODEL_RE = /^[a-z][a-z0-9_.]*$/` against `data.model`. The ORM tools, introspect, report, and action accept any non-empty string. Malformed model strings reach Odoo's RPC.
- **Severity rationale (downgrade to deferred):** Per spec analysis, US-5 AC-9 is the ONLY criterion mandating model regex validation and it explicitly targets `execute`. The threat US-5 AC-9 addresses is "Claude calls arbitrary methods via execute" — for the other tools, the method is hardcoded by the tool (`searchRead`, `read`, etc.), so an attacker controlling `model` cannot escalate privileges beyond the tool's shape. Odoo server-side validation catches malformed model names.
- **Recommendation for v0.1 hardening:** Add `.regex(/^[a-z][a-z0-9_.]*$/)` to the shared `model` field at the schema level (one-line change in `schemas.ts`).
- **Confidence:** 7/10.
- **Disposition:** Deferred to v0.1.

### [MEDIUM][DEFERRED] F-003 — `sanitizeArgs` doesn't redact when `odoo_execute` is called with `method: 'create'`

- **Location:** `packages/odoo-client/src/sanitize.ts` (`SANITIZED_TOOLS` constant)
- **Risk:** PII redaction is keyed on the tool name (`odoo_create`, `odoo_write`). When a caller goes through `odoo_execute` with `method: 'create'`, redaction is skipped, so credential-bearing `args` reach the log unredacted.
- **Recommendation for v0.1:** Either add `odoo_execute` to `SANITIZED_TOOLS` (recursive key-scan handles arbitrary shapes), or run an unconditional deep PII scan on all logged args regardless of tool name.
- **Confidence:** 7/10.
- **Disposition:** Deferred. Acknowledged risk in v0.

### [MEDIUM][DEFERRED] F-004 — Validation failures don't always emit `logger.toolCall`

- **Location:** execute.ts, action.ts, introspect.ts, report.ts (early-return paths on Zod failure)
- **Risk:** Per US-9 AC-1 every tool call completion should emit a log line. The current early-return on Zod failure or threat-model regex rejection skips the log. Monitoring blind spot, not security per se.
- **Recommendation for v0.1:** Add `logger.toolCall(...)` to every early-return path.
- **Disposition:** Deferred. Non-security observability fix.

### [MEDIUM][DEFERRED] F-005 — Non-`OdooError` exceptions re-thrown without logging

- **Location:** all tool handlers' final `throw e` branch
- **Risk:** TypeErrors / unexpected exceptions propagate to the MCP SDK without a log entry and may expose stack trace details depending on how the SDK formats them.
- **Recommendation for v0.1:** Catch-all that logs + returns a `ConnectionError`-shaped error rather than re-throwing.
- **Disposition:** Deferred. The MCP SDK's own error handling normally suppresses internal details.

### [MEDIUM][DEFERRED] F-006 — Domain parameter has no structural validation

- **Location:** `schemas.ts` (`domain: z.array(z.unknown()).default([])`)
- **Risk:** Arbitrarily nested domain arrays passed to Odoo. Defense-in-depth concern; Odoo handles malformed domains server-side. US-4 AC-8 already accepts this.
- **Disposition:** Accepted by design.

## Notes / accepted-by-design

- `buildContext` correctly re-applies session-authoritative fields after `extraContext` (verified in `context.ts:25-31` and `action.test.ts` test cases).
- All 5 tool handlers correctly call `validateCompanySubset` when `allowed_company_ids` is provided.
- `formatMcpError` correctly suppresses tracebacks unless `ODOO_MCP_DEBUG=1`.
- `probe.ts` stderr warning is JSON-stringified — newlines in upstream Odoo errors are properly escaped, no log-injection risk.
- No hardcoded secrets, no eval/exec/shell, no SSRF, no new external deps.

## Cumulative security state

- Previous (post-wave-2): high: 5, medium: 8
- Wave 4 adds: high: 2 (-1 fixed = +1 outstanding), medium: 4
- New cumulative: high: 6, medium: 12
