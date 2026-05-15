# MCP Resource Reference — @netlinks/odoo-mcp

Seven read-only resources that expose Odoo instance metadata to Claude.

Resources are populated once at server startup via a capability probe (`runProbe`). The probe runs 7 sub-queries in parallel using `Promise.allSettled`. After that, each resource read is an O(1) closure lookup — no network round-trip to Odoo occurs on subsequent reads. The probe snapshot is immutable for the lifetime of the server process.

If a probe sub-query fails (e.g. the user lacks access to a model), the corresponding resource returns `{ "error": "<message>" }` as its JSON content. The server never throws in this case — error transparency is preserved without crashing the MCP connection. See [troubleshooting](./troubleshooting.md) for the "All probe sub-queries failed" warning.

All resources return content with `mimeType: "application/json"`.

---

## odoo://modules

Installed Odoo modules.

- **URI:** `odoo://modules`
- **Source:** `ir.module.module` where `state = 'installed'`; limit 500
- **Cardinality:** Array of objects

**Success shape:**

```json
[
  { "name": "base", "version": "17.0.1.3.0" },
  { "name": "sale_management", "version": "17.0.1.0.1" }
]
```

**Failure shape:**

```json
{ "error": "You are not allowed to access 'Module' records." }
```

---

## odoo://reports

Available QWeb reports.

- **URI:** `odoo://reports`
- **Source:** `ir.actions.report`; fields `report_name`, `model`, `report_type`
- **Cardinality:** Array of objects (default search limit of 80 applies)

**Success shape:**

```json
[
  {
    "report_name": "account.report_invoice",
    "model": "account.move",
    "report_type": "qweb-pdf"
  },
  {
    "report_name": "sale.report_saleorder",
    "model": "sale.order",
    "report_type": "qweb-pdf"
  }
]
```

Use the `report_name` value as the `report_id` argument to `odoo_run_report`.

**Failure shape:**

```json
{ "error": "Access denied." }
```

---

## odoo://server-actions

Registered server actions.

- **URI:** `odoo://server-actions`
- **Source:** `ir.actions.server`; fields `name`, `model_id`, `type`
- **Cardinality:** Array of objects (default search limit of 80 applies)

**Success shape:**

```json
[
  {
    "name": "Send Quotation by Email",
    "model": "sale.order",
    "type": "ir.actions.server"
  }
]
```

**Failure shape:**

```json
{ "error": "You are not allowed to access 'Server Action' records." }
```

---

## odoo://companies

Companies accessible to the authenticated user.

- **URI:** `odoo://companies`
- **Source:** `res.company`; fields `id`, `name`, `currency_id`
- **Cardinality:** Array of objects

**Success shape:**

```json
[
  {
    "id": 1,
    "name": "NETLINKS",
    "currency_id": [2, "USD"]
  },
  {
    "id": 3,
    "name": "NETLINKS EU",
    "currency_id": [1, "EUR"]
  }
]
```

`currency_id` is a Many2one tuple `[id, display_name]`.

**Failure shape:**

```json
{ "error": "You are not allowed to access 'Company' records." }
```

---

## odoo://currencies

Active currencies on the Odoo instance.

- **URI:** `odoo://currencies`
- **Source:** `res.currency` where `active = true`; fields `id`, `name`, `symbol`
- **Cardinality:** Array of objects

**Success shape:**

```json
[
  { "id": 1, "name": "EUR", "symbol": "€" },
  { "id": 2, "name": "USD", "symbol": "$" }
]
```

**Failure shape:**

```json
{ "error": "Access denied." }
```

---

## odoo://fiscal-year

Current fiscal year date range.

- **URI:** `odoo://fiscal-year`
- **Source:** `account.fiscal.year`, first record; fields `date_from`, `date_to`
- **Cardinality:** Single object

**Fallback behavior:** If the `account.fiscal.year` model does not exist on this Odoo instance (raises `OdooMissingError`), or if the model has no records, the probe returns a synthetic fiscal year of `YYYY-01-01` / `YYYY-12-31` where `YYYY` is the current calendar year at server startup. This is the only probe sub-query with an internal fallback — it always succeeds.

**Success shape:**

```json
{ "date_from": "2026-01-01", "date_to": "2026-12-31" }
```

**Failure shape** (access denied, not missing-model):

```json
{ "error": "Access denied." }
```

---

## odoo://user-context

Language and timezone for the authenticated user.

- **URI:** `odoo://user-context`
- **Source:** `res.users.context_get()` RPC call; extracts `lang` and `tz` keys
- **Cardinality:** Single object with two string fields

**Success shape:**

```json
{ "language": "en_US", "locale": "Europe/Paris" }
```

`language` is the Odoo language code (e.g. `en_US`, `fr_FR`). `locale` is the user's timezone string.

**Failure shape:**

```json
{ "language": { "error": "..." }, "locale": { "error": "..." } }
```

Both `language` and `locale` come from the same sub-query, so they fail together.
