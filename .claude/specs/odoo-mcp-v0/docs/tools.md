# MCP Tool Reference — @netlinks/odoo-mcp

Ten tools exposed to Claude over the MCP stdio transport. Every tool returns a single text content block. On error, `isError` is `true` and the text is a JSON object with at minimum `error_type` and `message` fields.

## Common fields

Every tool accepts two optional multi-company fields:

| Field | Type | Description |
|-------|------|-------------|
| `allowed_company_ids` | `number[]` | Restrict this call to a subset of companies. Every ID must be in the session's `allowedCompanyIds`; any foreign ID yields `InputValidationError`. |
| `active_company_id` | `number` | Set the active company for this call. Must also be a positive integer. |

If omitted, `allowed_company_ids` defaults to the session's full set and `active_company_id` defaults to `session.companyId`.

## Error response shape

```json
{
  "error_type": "AccessError",
  "message": "You are not allowed to access 'Sales Order' (sale.order) records.",
  "model": "sale.order",
  "method": "search_read",
  "traceback": "..."
}
```

`traceback` is only present when `ODOO_MCP_DEBUG=1` is set. `model` and `method` are omitted for auth and connection errors. See [troubleshooting](./troubleshooting.md) for resolution steps by `error_type`.

---

## odoo_search_read

Search records and return field values in one call.

### Schema

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `model` | string | yes | — | Must match `/^[a-z][a-z0-9_.]*$/` |
| `domain` | array | no | `[]` | Odoo domain expression |
| `fields` | string[] | no | `[]` | Field names to return. Empty = all fields. |
| `limit` | integer | no | `80` | Positive integer. Capped at Odoo's server limit. |
| `offset` | integer | no | `0` | Non-negative integer for pagination. |
| `order` | string | no | — | e.g. `"name asc"` |
| `allowed_company_ids` | integer[] | no | — | |
| `active_company_id` | integer | no | — | |

### Returns

JSON array of records, each a flat object with `id` plus the requested fields.

```json
[
  { "id": 1, "name": "ACME Corp", "email": "info@acme.com" },
  { "id": 2, "name": "Globex", "email": "info@globex.com" }
]
```

### Example invocations

```json
{
  "model": "res.partner",
  "domain": [["is_company", "=", true]],
  "fields": ["name", "email", "phone"],
  "limit": 10,
  "order": "name asc"
}
```

```json
{
  "model": "sale.order",
  "domain": [["state", "in", ["draft", "sent"]]],
  "fields": ["name", "partner_id", "amount_total"],
  "allowed_company_ids": [1, 3]
}
```

```json
{
  "model": "product.product",
  "domain": [["type", "=", "consu"], ["active", "=", true]],
  "fields": ["name", "list_price", "categ_id"],
  "limit": 50,
  "offset": 50
}
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `InputValidationError` | `model` failed regex, `limit` is 0 or negative, `offset` is negative |
| `AccessError` | User cannot read this model |
| `ConnectionError` | Odoo unreachable |

---

## odoo_read

Fetch specific records by ID.

### Schema

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `model` | string | yes | — | Must match `/^[a-z][a-z0-9_.]*$/` |
| `ids` | integer[] | yes | — | At least one positive integer |
| `fields` | string[] | no | `[]` | Empty = all fields |
| `allowed_company_ids` | integer[] | no | — | |
| `active_company_id` | integer | no | — | |

### Returns

JSON array of records. Records are returned in Odoo's order, which may differ from the input `ids` order.

### Example invocations

```json
{ "model": "res.partner", "ids": [42, 43], "fields": ["name", "street", "city"] }
```

```json
{ "model": "sale.order", "ids": [100], "fields": ["name", "state", "amount_total"] }
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `MissingError` | One or more IDs do not exist or are not accessible |
| `AccessError` | User cannot read this model |

---

## odoo_create

Create one or more records.

### Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Must match `/^[a-z][a-z0-9_.]*$/` |
| `values` | object or object[] | yes | Field-value map for one record, or array of maps for batch create |
| `allowed_company_ids` | integer[] | no | |
| `active_company_id` | integer | no | |

### Returns

The new record ID (integer) for single create, or an array of IDs for batch create.

### Example invocations

```json
{
  "model": "res.partner",
  "values": { "name": "ACME Corp", "is_company": true, "email": "info@acme.com" }
}
```

```json
{
  "model": "res.partner",
  "values": [
    { "name": "Alice", "parent_id": 1 },
    { "name": "Bob", "parent_id": 1 }
  ]
}
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `ValidationError` | Required field missing, unique constraint violated |
| `AccessError` | User cannot create on this model |
| `UserError` | Business rule blocks creation |

---

## odoo_write

Update fields on existing records.

### Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Must match `/^[a-z][a-z0-9_.]*$/` |
| `ids` | integer[] | yes | At least one positive integer |
| `values` | object | yes | Field-value map; applied to all IDs |
| `allowed_company_ids` | integer[] | no | |
| `active_company_id` | integer | no | |

### Returns

`true` on success.

### Example invocations

```json
{
  "model": "res.partner",
  "ids": [42],
  "values": { "email": "new@acme.com", "phone": "+1-555-0100" }
}
```

```json
{
  "model": "sale.order",
  "ids": [10, 11, 12],
  "values": { "note": "Approved for Q3" }
}
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `MissingError` | One or more IDs no longer exist |
| `ValidationError` | Constraint violation on the new values |
| `AccessError` | User cannot write on this model or record |

---

## odoo_unlink

Delete records permanently.

### Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | Must match `/^[a-z][a-z0-9_.]*$/` |
| `ids` | integer[] | yes | At least one positive integer |
| `allowed_company_ids` | integer[] | no | |
| `active_company_id` | integer | no | |

### Returns

`true` on success.

### Example invocations

```json
{ "model": "res.partner", "ids": [99] }
```

```json
{ "model": "account.move", "ids": [55, 56], "allowed_company_ids": [1] }
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `UserError` | Record is referenced by another record and cannot be deleted |
| `AccessError` | User cannot unlink on this model |
| `MissingError` | Record already deleted |

---

## odoo_search_count

Count matching records without fetching data.

### Schema

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `model` | string | yes | — | Must match `/^[a-z][a-z0-9_.]*$/` |
| `domain` | array | no | `[]` | |
| `allowed_company_ids` | integer[] | no | — | |
| `active_company_id` | integer | no | — | |

### Returns

A single integer.

```json
142
```

### Example invocations

```json
{ "model": "res.partner", "domain": [["is_company", "=", true]] }
```

```json
{ "model": "sale.order", "domain": [["state", "=", "sale"]], "allowed_company_ids": [1, 2] }
```

---

## odoo_execute

Call any model method by name. **High-privilege tool** — the method name is validated against a strict regex before dispatch.

### Threat model

`model` must match `/^[a-z][a-z0-9_.]*$/`. `method` must match `/^[a-z_][a-z0-9_]*$/`. These regexes are enforced at the Zod schema layer before any RPC call is made. They prevent injection of camelCase, dunder (`__`), or shell-special characters. Private Odoo methods (typically prefixed `_`) can still be called if the user's Odoo security groups permit it — the connector does not add an Odoo-side restriction beyond what the authenticated user already has.

### Schema

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `model` | string | yes | — | `/^[a-z][a-z0-9_.]*$/` |
| `method` | string | yes | — | `/^[a-z_][a-z0-9_]*$/` |
| `args` | array | no | `[]` | Positional arguments |
| `kwargs` | object | no | `{}` | Keyword arguments |
| `allowed_company_ids` | integer[] | no | — | |
| `active_company_id` | integer | no | — | |

### Returns

The raw return value of the Odoo method, JSON-serialized. Shape varies by method.

### Example invocations

```json
{
  "model": "sale.order",
  "method": "action_confirm",
  "args": [[42, 43]]
}
```

```json
{
  "model": "res.users",
  "method": "context_get",
  "args": [],
  "kwargs": {}
}
```

```json
{
  "model": "account.move",
  "method": "action_post",
  "args": [[101]],
  "allowed_company_ids": [1]
}
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `InputValidationError` | `method` contains uppercase or special chars outside `[a-z0-9_]` |
| `AccessError` | User's Odoo groups do not permit this method on this model |
| `UserError` | Business rule raised by the method |

---

## odoo_run_report

Render a QWeb PDF report and return base64-encoded content.

### Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `report_id` | integer or string | yes | Numeric `ir.actions.report` ID or `report_name` string (e.g. `"account.report_invoice"`) |
| `doc_ids` | integer[] | yes | At least one record ID to include in the report |
| `allowed_company_ids` | integer[] | no | |
| `active_company_id` | integer | no | |

### Returns

```json
{
  "content": "<base64-encoded PDF bytes>",
  "contentType": "application/pdf"
}
```

Decode `content` with `Buffer.from(content, 'base64')` or equivalent.

### Example invocations

```json
{
  "report_id": "account.report_invoice",
  "doc_ids": [101, 102]
}
```

```json
{
  "report_id": 47,
  "doc_ids": [55],
  "allowed_company_ids": [1]
}
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `InputValidationError` | `doc_ids` is empty |
| `AccessError` | User cannot render this report |
| `UserError` | Odoo raised a business-rule error during rendering |

---

## odoo_call_action

Call a server action or button method on a set of records. Accepts an optional caller-supplied `context` that is merged before session-authoritative fields are applied — callers cannot override `uid`, `company_id`, or `allowed_company_ids` this way.

### Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | `/^[a-z][a-z0-9_.]*$/` |
| `ids` | integer[] | yes | At least one positive integer |
| `action_name` | string | yes | `/^[a-z_][a-z0-9_]*$/` |
| `context` | object | no | Merged into RPC context; identity fields cannot be overridden |
| `allowed_company_ids` | integer[] | no | |
| `active_company_id` | integer | no | |

### Returns

The raw return value of the action, JSON-serialized. This is often an Odoo action dict or `false`.

### Example invocations

```json
{
  "model": "sale.order",
  "ids": [10],
  "action_name": "action_confirm"
}
```

```json
{
  "model": "account.move",
  "ids": [55, 56],
  "action_name": "action_post",
  "context": { "default_journal_id": 1 }
}
```

### Threat model

`action_name` uses the same `METHOD_NAME` regex as `odoo_execute`. The `context` field is user-supplied but the merge order guarantees `uid`, `company_id`, and `allowed_company_ids` are always re-applied from the session after any caller values.

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `InputValidationError` | `action_name` contains chars outside `/^[a-z_][a-z0-9_]*$/` |
| `AccessError` | User cannot call this action on this model |

---

## odoo_fields_get

Return field metadata for a model.

### Schema

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `model` | string | yes | `/^[a-z][a-z0-9_.]*$/` |
| `attributes` | string[] | no | Filter which field attributes to return, e.g. `["string", "type", "required"]` |
| `allowed_company_ids` | integer[] | no | |
| `active_company_id` | integer | no | |

### Returns

An object keyed by field technical name. Each value is a dict of the requested attributes.

```json
{
  "name": { "string": "Name", "type": "char", "required": true },
  "email": { "string": "Email", "type": "char", "required": false },
  "partner_id": { "string": "Customer", "type": "many2one", "required": true }
}
```

### Example invocations

```json
{
  "model": "res.partner",
  "attributes": ["string", "type", "required", "readonly"]
}
```

```json
{ "model": "sale.order" }
```

### Common errors

| `error_type` | Cause |
|-------------|-------|
| `InputValidationError` | `model` failed regex |
| `AccessError` | User cannot introspect this model |
