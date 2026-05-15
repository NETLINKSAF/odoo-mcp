# Wave 2 Security Review — auth strategy

**Reviewer:** spec-security-reviewer (read-only)
**Date:** 2026-05-15
**Files reviewed:** `packages/odoo-client/src/auth.ts`, `packages/odoo-client/tests/auth.test.ts`
**Diff range:** `21048148df93b5b4d24997f924d11163fbd3f633..HEAD`

## Summary

- CRITICAL: 0
- HIGH: 1
- MEDIUM: 2
- LOW: 0
- INFORMATIONAL: 0

No blocking issues. No debugger dispatch.

## Findings

### [HIGH] F-001: No URL validation on `config.url` — SSRF vector via `fetch()`

- **Location:** `packages/odoo-client/src/auth.ts:94`
- **Pattern:** `fetch(\`${config.url}/web/session/authenticate\`)` with no `new URL()` parse, no scheme allowlist, no hostname validation.
- **Risk:** If untrusted input reaches `OdooConfig.url`, the `fetch()` call may target arbitrary destinations (cloud metadata endpoints, `file://`, internal services). Mitigated in primary path because URL comes from an env var, but the library is exported for programmatic use.
- **Recommendation:** Validation belongs in **T-9 (Config loader)** per US-1 AC-3 (`https?://.+` pattern). Confirm T-9 implements: `new URL(value)` parse, scheme allowlist (`http:` / `https:`), and optionally reject private/link-local IP ranges. Add a comment in auth.ts noting that URL is assumed pre-validated.
- **Confidence:** 5/10
- **Disposition:** Non-blocking. Tracked as expected upstream mitigation in T-9.

### [MEDIUM] F-002: Odoo debug traceback unconditionally stored in error objects

- **Location:** `packages/odoo-client/src/auth.ts:125,127`
- **Pattern:** `throw new OdooAuthError(message, debug)` stores raw Odoo Python traceback in `.traceback`. By design at the client layer; filtering deferred to MCP layer.
- **Risk:** If downstream code logs/serializes the error without filtering, traceback leaks (file paths, module names, internal state). US-8 AC-6 mandates traceback exposure only when `ODOO_MCP_DEBUG=1`.
- **Recommendation:** Acceptable at the `odoo-client` library level. Ensure **T-11 (MCP error formatter)** strips `.traceback` unless `ODOO_MCP_DEBUG=1`. Add an explicit comment in auth.ts documenting this contract.
- **Confidence:** 4/10
- **Disposition:** Non-blocking. Tracked as expected mitigation in T-11.

### [MEDIUM] F-003: `createAuthStrategy` fallback doubles authentication attempts

- **Location:** `packages/odoo-client/src/auth.ts:154-176`
- **Pattern:** On `OdooAuthError`, same credentials retried immediately with `SessionCookieAuthStrategy` — no delay, no backoff.
- **Risk:** Doubles rate against Odoo-side rate limiter if `createAuthStrategy` is invoked per-request by an upstream caller. Low real-world impact because auth runs once at server startup (not per-request) in the MCP design.
- **Recommendation:** Document as accepted risk for v0. If auth becomes per-request in a future version, add exponential backoff.
- **Confidence:** 3/10
- **Disposition:** Accepted for v0.

## Notes / accepted-by-design

- `applyAuth` as structural no-op on both strategies — intentional, `JsonRpcRequest` carries no headers field.
- `declare const process` ambient declaration — avoids `@types/node` runtime dependency.
- US-2 AC-5 plaintext warning at `createAuthStrategy:155-162` — correctly emitted BEFORE the fetch call (verified by test TC-7 ordering assertion).
- Cookie regex `/session_id=([^;]+)/` — safe; `[^;]+` prevents cross-cookie reads; value never crosses a user-input boundary.
- Test fixtures use obvious dummy values (`s3cr3t`, `abc123xyz`, `sess999`) — not real credentials.
- No new runtime deps. No `preinstall`/`install`/`postinstall` scripts. No `eval`, `Function`, `vm.run`.
- 30s timeout consistent with US-8 AC-7 and existing `rpc.ts` pattern.

## Disposition

All 3 findings are non-blocking and have planned upstream mitigations (T-9 for SSRF, T-11 for traceback). No CRITICAL findings → no debugger dispatch. Cumulative security state:

- Previous high: 4, medium: 6 (from threat-modeling phase)
- Wave 2 adds: high: 1, medium: 2
- New cumulative: high: 5, medium: 8 (pending re-baselining at acceptance phase)
