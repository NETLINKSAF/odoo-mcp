# Documentation Audit — odoo-mcp-v0 (post-hardening)

## Summary
- Files scanned: 16 (7 in `packages/odoo-client/src/`, 9 in `packages/odoo-mcp/src/` + 5 under `tools/`)
- Exports without docs: ~14 (down from ~24)
- Coverage: ~75% (42 of ~56 exports documented; vs previous ~56%)
- High-priority gaps: 2

---

## Gaps

### High-priority

- **`OdooClient` class and all 10 methods** (`client.ts`) — the most-used public surface
  in the package has no class-level JSDoc and no method-level JSDoc. Non-obvious contracts
  include: `searchRead` applies `DEFAULT_SEARCH_LIMIT = 80` silently; `runReport` returns
  base64 PDF (only hinted by an inline comment inside the body, not at the signature);
  `execute` kwargs semantics (maps to Odoo `execute_kw` keyword args) are unstated;
  `callAction` delegates to `execute` and `actionName` must be a method name, not an XML id.

- **`ApiKeyAuthStrategy` class** (`auth.ts`) — no class-level JSDoc. `SessionCookieAuthStrategy`
  has a class-level doc block; `ApiKeyAuthStrategy` does not. The `applyAuth` method on both
  concrete classes is a deliberate no-op (cookie injection happens via the `headers` arg to
  `jsonRpc` at the call site), but `ApiKeyAuthStrategy.applyAuth` carries no comment to that
  effect, unlike its sibling.

### Remaining (low-impact)

- **`AppConfig` interface** (`config.ts`) — no JSDoc. The `logFile` field's side-effects
  (append-mode open at startup, `process.exit(1)` on write failure) are undocumented at the
  type level; they only appear as inline comments inside `loadConfig`.

- **`loadConfig` function** (`config.ts`) — exported, no JSDoc. The `process.exit(1)` on
  invalid env is a critical caller contract invisible at the signature.

- **`Logger` interface** (`logger.ts`) — no JSDoc. `toolCall`, `startup`, `shutdown` method
  shapes are self-explanatory from field names but the "stderr always, file optionally"
  contract is undocumented at the interface level.

- **`McpServerConfig` interface** (`server.ts`) — no JSDoc. The `logFile` field's behaviour
  inherited from `createLogger` is not restated here.

- **`McpToolError` interface and `formatMcpError`** (`errors.ts`) — no JSDoc on either.
  The `ODOO_MCP_DEBUG=1` gate on traceback inclusion is only visible by reading the body.

- **`registerAllTools`, `registerExecuteTool`, `registerActionTool`, `registerReportTool`,
  `registerIntrospectTool`** (`tools/`) — no JSDoc. `registerOrmTools` has JSDoc; the other
  four register functions do not. All are internal-only (not re-exported from `index.ts`)
  so impact is limited to contributors.

- **Zod schema exports in `tools/schemas.ts`** — 10 schema constants and 8 inferred type
  aliases exported with no JSDoc. Low risk: schemas are self-documenting through Zod's
  structure and the regex patterns carry inline comments.

---

## Improvements since previous audit

- All 7 error classes now have JSDoc (`OdooError` through `OdooConnectionError`).
- `AuthStrategy` interface now has JSDoc including the `applyAuth` extension-point rationale.
- `JsonRpcRequest` / `JsonRpcResponse` now have one-line JSDoc.
- `jsonRpc` now has a full JSDoc block describing timeout, error mapping, and the headers arg.
- `sanitizeArgs` now has full JSDoc with `@param` / `@returns` tags; `PII_KEY_PATTERN` and
  `SANITIZED_TOOLS` now carry explanatory comments.
- `REQUEST_TIMEOUT_MS`, `DEFAULT_SEARCH_LIMIT`, `MODULE_PROBE_LIMIT` replace three magic
  numbers; `REQUEST_TIMEOUT_MS` has a JSDoc comment tying it to US-8 AC-7.
- `buildContext` and `validateCompanySubset` both have JSDoc (threat-model references intact).
- `runProbe` and `registerResources` both have JSDoc.
- `createLogger` has JSDoc describing the fd lifecycle.
- `createOdooMcpServer` and `registerOrmTools` have JSDoc.

---

## Notes

- The dead-code flag from the previous audit (`OdooClient.probe()`) has been resolved:
  the method was removed during v0.1 hardening per the inline comment at `client.ts:210-213`.
- The `applyAuth` no-op situation (both concrete strategies return the request unchanged) is
  now explained on `SessionCookieAuthStrategy` and in the `AuthStrategy` JSDoc, but remains
  unexplained on `ApiKeyAuthStrategy.applyAuth` itself.
- Threat-model `US-X / AC-Y` inline references are consistently present in all
  security-sensitive paths and were unaffected by the hardening pass.
