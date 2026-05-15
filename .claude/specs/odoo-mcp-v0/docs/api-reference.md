# API Reference — @netlinks/odoo-client

Standalone TypeScript JSON-RPC client for Odoo 19. Zero MCP dependency; usable in any Node.js or Bun project.

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `REQUEST_TIMEOUT_MS` | `30000` | Per-request abort threshold (ms). Aligned with Odoo's worker timeout. |
| `DEFAULT_SEARCH_LIMIT` | `80` | Applied by `OdooClient.searchRead` when no `limit` is supplied. |

---

## Types

### `DomainOperator`

String union of all comparison operators Odoo accepts in domain filters.

```
'=' | '!=' | '>' | '>=' | '<' | '<=' | 'like' | 'ilike' |
'not like' | 'not ilike' | '=like' | '=ilike' | 'in' | 'not in' |
'child_of' | 'parent_of'
```

### `DomainLeaf`

```ts
type DomainLeaf = [field: string, operator: DomainOperator, value: unknown]
```

Single filter condition, e.g. `['state', '=', 'draft']`.

### `DomainConnector`

```ts
type DomainConnector = '&' | '|' | '!'
```

Prefix logical connectors for Polish-notation domain composition.

### `Domain`

```ts
type Domain = Array<DomainLeaf | DomainConnector>
```

Full Odoo domain expression. An empty array `[]` matches all records.

### `Context`

```ts
type Context = Record<string, unknown>
```

Odoo context dictionary. Merged and serialized as a plain JSON object on every RPC call.

### `OdooRecord`

```ts
type OdooRecord = Record<string, unknown> & { id: number }
```

Generic record returned by `search_read` / `read`. Always contains `id`.

### `CompanyContext`

```ts
interface CompanyContext {
  allowed_company_ids?: number[];
  active_company_id?: number;
}
```

Multi-company context fields accepted by every MCP tool. Validated against `session.allowedCompanyIds` before use.

### `OdooConfig`

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | Base URL of the Odoo instance, no trailing slash |
| `db` | `string` | Database name |
| `username` | `string` | Login name (email or login) |
| `apiKey` | `string` | Odoo API key (Settings → Users → API Keys) |

### `OdooSession`

Returned by `OdooClient.authenticate()` and stored in the client.

| Field | Type | Description |
|-------|------|-------------|
| `uid` | `number` | Authenticated user ID |
| `sessionId` | `string \| undefined` | Cookie value; present only in `SessionCookieAuthStrategy` mode |
| `companyId` | `number` | Default company for the session |
| `allowedCompanyIds` | `number[]` | Full set of companies the user may switch to |
| `userContext` | `Context` | `user_context` dict from Odoo's authenticate response |

### `ProbeResult`

Capability snapshot assembled by the MCP server at startup. Each field is either the data array/object or `{ error: string }` if that sub-query failed.

| Field | Type |
|-------|------|
| `modules` | `Array<{ name: string; version: string }> \| { error: string }` |
| `reports` | `Array<{ report_name: string; model: string; report_type: string }> \| { error: string }` |
| `serverActions` | `Array<{ name: string; model: string; type: string }> \| { error: string }` |
| `companies` | `Array<{ id: number; name: string; currency_id: [number, string] }> \| { error: string }` |
| `currencies` | `Array<{ id: number; name: string; symbol: string }> \| { error: string }` |
| `fiscalYear` | `{ date_from: string; date_to: string } \| { error: string }` |
| `language` | `string \| { error: string }` |
| `locale` | `string \| { error: string }` |

---

## Error Classes

All errors extend `OdooError extends Error`.

### `OdooError` (base)

```ts
new OdooError(
  errorType: string,
  message: string,
  model?: string,
  method?: string,
  traceback?: string
)
```

| Field | Type | Description |
|-------|------|-------------|
| `errorType` | `string` | Discriminator string for switch/catch logic |
| `message` | `string` | Human-readable description |
| `model` | `string \| undefined` | Odoo model involved (not set for auth errors) |
| `method` | `string \| undefined` | ORM method involved |
| `traceback` | `string \| undefined` | Python traceback from Odoo's debug field. Never log without explicit opt-in. |

### `OdooAuthError`

```ts
new OdooAuthError(message: string, traceback?: string)
// errorType = 'OdooAuthError'
```

Thrown when authentication is rejected (`odoo.exceptions.AccessDenied`) or when the session response is missing required fields (`uid`, `company_id`, etc.). `model` and `method` are always undefined.

### `OdooUserError`

```ts
new OdooUserError(message: string, model?: string, method?: string, traceback?: string)
// errorType = 'UserError'
```

Thrown when Odoo raises `odoo.exceptions.UserError`. The message is intended to be shown verbatim to the end user — it describes a business-rule violation.

### `OdooValidationError`

```ts
new OdooValidationError(message: string, model?: string, method?: string, traceback?: string)
// errorType = 'ValidationError'
```

Thrown for `odoo.exceptions.ValidationError`. Indicates a data-layer constraint failure (e.g. unique constraint, required field), distinct from a business-logic UserError.

### `OdooAccessError`

```ts
new OdooAccessError(message: string, model?: string, method?: string, traceback?: string)
// errorType = 'AccessError'
```

Thrown for `odoo.exceptions.AccessError`. The authenticated session is valid but the user lacks permission on the target model or record. Different from `OdooAuthError`, which means the session itself could not be established.

### `OdooMissingError`

```ts
new OdooMissingError(message: string, model?: string, method?: string, traceback?: string)
// errorType = 'MissingError'
```

Thrown for `odoo.exceptions.MissingError`. The targeted record ID no longer exists or was never accessible. Common cause: stale ID after deletion in another session.

### `OdooConnectionError`

```ts
new OdooConnectionError(message: string)
// errorType = 'ConnectionError'
```

Thrown for transport-layer failures: DNS resolution failure, connection refused, TLS error, or the 30-second abort timeout. No `traceback` because the failure occurred before Odoo returned any response.

---

## `jsonRpc` Transport Function

```ts
async function jsonRpc(
  url: string,
  endpoint: string,
  params: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown>
```

Low-level single-request transport. Composes the JSON-RPC 2.0 envelope, POSTs to `${url}${endpoint}`, applies a 30-second abort timeout, and maps server fault objects onto the typed error hierarchy.

| Param | Type | Description |
|-------|------|-------------|
| `url` | `string` | Odoo base URL |
| `endpoint` | `string` | Path, e.g. `/web/dataset/call_kw` |
| `params` | `Record<string, unknown>` | Value of the `params` key in the JSON-RPC envelope |
| `headers` | `Record<string, string> \| undefined` | Optional headers, e.g. `{ Cookie: 'session_id=...' }` |

**Returns:** The `result` field from the Odoo response, typed as `unknown`.

**Throws:** `OdooAuthError`, `OdooUserError`, `OdooValidationError`, `OdooAccessError`, `OdooMissingError`, `OdooConnectionError`, or `OdooError` (base, for unrecognized fault names).

```ts
// Example: direct RPC call (prefer OdooClient for normal use)
import { jsonRpc } from '@netlinks/odoo-client';

const result = await jsonRpc('https://my.odoo.com', '/web/dataset/call_kw', {
  model: 'res.partner',
  method: 'search_count',
  args: [[]],
  kwargs: {},
});
```

---

## `OdooClient` Class

High-level ORM wrapper. Call `authenticate()` before any ORM method — attempting ORM calls without authentication throws `OdooAuthError('Not authenticated — call authenticate() first')`.

### Constructor

```ts
new OdooClient(config: OdooConfig)
```

### `authenticate()`

```ts
async authenticate(): Promise<OdooSession>
```

Runs the auth strategy selection and login round-trip. Stores the resulting session internally. Subsequent ORM calls use this session.

**Throws:** `OdooAuthError` if credentials are wrong or the response is malformed. `OdooConnectionError` on network failure.

```ts
const client = new OdooClient({
  url: 'https://my.odoo.com',
  db: 'prod',
  username: 'admin',
  apiKey: 'abc123',
});
const session = await client.authenticate();
console.log(session.uid, session.allowedCompanyIds);
```

### `searchRead()`

```ts
async searchRead(
  model: string,
  domain: Domain,
  fields?: string[],
  options?: { limit?: number; offset?: number; order?: string; context?: Context },
): Promise<OdooRecord[]>
```

| Param | Description |
|-------|-------------|
| `model` | Odoo model technical name, e.g. `'res.partner'` |
| `domain` | Filter expression. `[]` returns all records. |
| `fields` | Field names to fetch. Omit for all fields (expensive). |
| `options.limit` | Max rows. Defaults to `80` (`DEFAULT_SEARCH_LIMIT`). |
| `options.offset` | Skip N rows for pagination. Default `0`. |
| `options.order` | Order string, e.g. `'name asc'`. |
| `options.context` | Merged into the RPC context. |

```ts
const partners = await client.searchRead(
  'res.partner',
  [['is_company', '=', true]],
  ['name', 'email'],
  { limit: 20, order: 'name asc' },
);
```

### `read()`

```ts
async read(
  model: string,
  ids: number[],
  fields?: string[],
  context?: Context,
): Promise<OdooRecord[]>
```

Fetch specific records by ID. Returns records in the order Odoo chooses (not necessarily the same as `ids`).

```ts
const records = await client.read('sale.order', [42, 43], ['name', 'state']);
```

### `create()`

```ts
async create(
  model: string,
  values: Record<string, unknown> | Record<string, unknown>[],
  context?: Context,
): Promise<number | number[]>
```

Create one record (pass an object) or multiple records (pass an array). Returns the new record ID or array of IDs.

**Throws:** `OdooValidationError` on constraint violation; `OdooAccessError` if the user cannot create on this model.

```ts
const id = await client.create('res.partner', { name: 'ACME Corp', is_company: true });
```

### `write()`

```ts
async write(
  model: string,
  ids: number[],
  values: Record<string, unknown>,
  context?: Context,
): Promise<boolean>
```

Update fields on one or more records. Returns `true` on success.

```ts
await client.write('res.partner', [42], { email: 'new@acme.com' });
```

### `unlink()`

```ts
async unlink(
  model: string,
  ids: number[],
  context?: Context,
): Promise<boolean>
```

Delete records. Returns `true`. Throws `OdooUserError` if any record is linked to another that prevents deletion.

```ts
await client.unlink('res.partner', [99]);
```

### `searchCount()`

```ts
async searchCount(
  model: string,
  domain: Domain,
  context?: Context,
): Promise<number>
```

Count records matching `domain` without fetching data.

```ts
const count = await client.searchCount('res.partner', [['is_company', '=', true]]);
```

### `execute()`

```ts
async execute(
  model: string,
  method: string,
  args?: unknown[],
  kwargs?: Record<string, unknown>,
  context?: Context,
): Promise<unknown>
```

Call any model method via `call_kw`. Return type is `unknown` — callers must narrow.

```ts
const result = await client.execute('sale.order', 'action_confirm', [[42]]);
```

### `runReport()`

```ts
async runReport(
  reportId: number | string,
  docIds: number[],
  context?: Context,
): Promise<{ content: string; contentType: 'application/pdf' }>
```

Render a QWeb PDF report. `reportId` is either a numeric `ir.actions.report` ID or the `report_name` string (e.g. `'account.report_invoice'`). `content` is base64-encoded PDF.

```ts
const { content, contentType } = await client.runReport(
  'account.report_invoice',
  [101, 102],
);
// Write base64 `content` to a file or return to caller.
```

### `callAction()`

```ts
async callAction(
  model: string,
  ids: number[],
  actionName: string,
  context?: Context,
): Promise<unknown>
```

Convenience wrapper around `execute` that passes `[ids]` as the first positional arg. Equivalent to calling a server action or button method on a set of records.

```ts
await client.callAction('sale.order', [42, 43], 'action_confirm');
```

### `fieldsGet()`

```ts
async fieldsGet(
  model: string,
  attributes?: string[],
  context?: Context,
): Promise<Record<string, unknown>>
```

Return field metadata for a model. `attributes` filters which field attributes are returned (e.g. `['string', 'type', 'required']`). If omitted, all attributes are returned.

```ts
const fields = await client.fieldsGet('res.partner', ['string', 'type']);
// { name: { string: 'Name', type: 'char' }, ... }
```

---

## Auth Strategy

### `AuthStrategy` Interface

```ts
interface AuthStrategy {
  authenticate(config: OdooConfig): Promise<OdooSession>;
  applyAuth(request: JsonRpcRequest, session: OdooSession): JsonRpcRequest;
}
```

`applyAuth` is a structural extension point. Both shipped strategies return the request unchanged because cookie/header injection happens at the `jsonRpc` call site via the `headers` argument. Custom strategies that need to mutate the request envelope can override this.

### `ApiKeyAuthStrategy`

Calls `/web/session/authenticate` with `password = config.apiKey`. The preferred strategy — no cookie handling required.

### `SessionCookieAuthStrategy`

Fallback for environments where API-key authentication is unavailable. Reads the `Set-Cookie: session_id=...` header from the authenticate response and stores it for subsequent requests.

### `createAuthStrategy(config)`

```ts
async function createAuthStrategy(config: OdooConfig): Promise<AuthStrategy>
```

Factory that tries `ApiKeyAuthStrategy` first. If that throws `OdooAuthError`, falls back to `SessionCookieAuthStrategy`. Writes a JSON warning to stderr if `config.url` starts with `http://`.

```ts
import { createAuthStrategy, OdooClient } from '@netlinks/odoo-client';

// OdooClient.authenticate() calls this internally.
// Direct use is only needed for custom auth integrations.
const strategy = await createAuthStrategy(config);
```

---

## `sanitizeArgs` Helper

```ts
function sanitizeArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown>
```

Returns a sanitized copy of `args` with values for any key matching `/password|credit_card|token|secret|api_key/i` replaced by `'[REDACTED]'`. For tools that only accept domains/IDs (`odoo_search_read`, `odoo_read`, `odoo_fields_get`, etc.) the original reference is returned with no clone or traversal. For write-path tools (`odoo_create`, `odoo_write`, `odoo_execute`, `odoo_call_action`) a deep clone is made before redaction — the original `args` is never mutated.

```ts
import { sanitizeArgs } from '@netlinks/odoo-client';

const safe = sanitizeArgs('odoo_create', {
  model: 'res.users',
  values: { name: 'Alice', password: 'hunter2' },
});
// safe.values.password === '[REDACTED]'
```

---

## Wire Types

Exported for callers that build custom transports.

### `JsonRpcRequest`

```ts
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: 'call';
  id: number;
  params: Record<string, unknown>;
}
```

### `JsonRpcResponse`

```ts
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data: { name: string; message: string; debug: string };
  };
}
```

---

## Error Mapping (Odoo Python → TypeScript)

| Odoo exception | Thrown class | `errorType` |
|----------------|-------------|-------------|
| `odoo.exceptions.AccessDenied` | `OdooAuthError` | `'OdooAuthError'` |
| `odoo.exceptions.UserError` | `OdooUserError` | `'UserError'` |
| `odoo.exceptions.ValidationError` | `OdooValidationError` | `'ValidationError'` |
| `odoo.exceptions.AccessError` | `OdooAccessError` | `'AccessError'` |
| `odoo.exceptions.MissingError` | `OdooMissingError` | `'MissingError'` |
| (unrecognized) | `OdooError` | `'ServerError'` |

See [troubleshooting](./troubleshooting.md) for resolution steps per error type.
