# Wiring Audit — odoo-mcp-v0

**Date:** 2026-05-15 (re-run after v0.1 hardening)
**HEAD:** 68050a4
**Methodology:** grep-based import + call-site verification for every task with `wired: "yes"` in state.json.

## Summary

- Tasks with `wired: "yes"`: **6** — all verified
- Tasks with `wired: "n/a"`: **18** — out of scope (interior libraries, terminal entry points)
- Tasks with `wired: "pending"`: **0**
- WIRING EVIDENCE GAP: Per-wave files were not written during /spec-loop; this consolidated audit replaces them and references the audit_log entries that recorded the grep results at wave-close time.

## Verification

| Task | Export | Importer | Call site | Status |
|---|---|---|---|---|
| T-14 | `registerOrmTools` | `tools/index.ts:8` | `tools/index.ts:17` | ✓ wired |
| T-15 | `registerExecuteTool` | `tools/index.ts:6` | `tools/index.ts:18` | ✓ wired |
| T-16 | `registerReportTool` | `tools/index.ts:9` | `tools/index.ts:19` | ✓ wired |
| T-17 | `registerActionTool` | `tools/index.ts:5` | `tools/index.ts:20` | ✓ wired |
| T-18 | `registerIntrospectTool` | `tools/index.ts:7` | `tools/index.ts:21` | ✓ wired |
| T-21 | `registerAllTools` | `server.ts:7` | `server.ts:44` | ✓ wired |

## n/a tasks (terminal / interior)

| Task | Reason for n/a |
|---|---|
| T-1..T-5, T-8 | Library types/errors/transport, consumed by client.ts (T-7) |
| T-6 | Auth strategy, consumed by client.ts via createAuthStrategy |
| T-7 | OdooClient class, consumed by server.ts (T-22) |
| T-9 | loadConfig, consumed by bin.ts (T-22) |
| T-10 | createLogger, consumed by server.ts (T-22) |
| T-11 | formatMcpError, consumed by all 5 tool handlers (T-14..T-18) |
| T-12 | buildContext / validateCompanySubset, consumed by all 5 tool handlers |
| T-13 | Zod schemas, consumed by all 5 tool handlers |
| T-19 | runProbe, consumed by server.ts (T-22) |
| T-20 | registerResources, consumed by server.ts (T-22) |
| T-22 | Terminal entry — package.json#bin → bin.js |
| T-23 | Manual smoke script — not wired by design |
| T-24 | Docs + config samples — nothing to wire |

## Anomaly noted (in first acceptance pass)

**Dead code candidate:** `OdooClient.probe()` (T-7) was exported but had zero call sites in `src/`.

**Resolution (commit 68050a4):** `OdooClient.probe()` method and its 4 associated tests have been removed. Verification:

```bash
$ grep -rn "client\.probe\|OdooClient.*probe(" packages/*/src/
(no matches)
$ grep -rn "client\.probe(" packages/*/tests/
(no matches)
```

The probe path is now single-implementation via `runProbe()` in `packages/odoo-mcp/src/probe.ts`.

## Conclusion

PASS — all `wired: "yes"` tasks have real importers and call sites. The previously flagged dead-code anomaly has been resolved. No outstanding wiring concerns.
