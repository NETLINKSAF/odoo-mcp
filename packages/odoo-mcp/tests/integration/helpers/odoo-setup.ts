/**
 * Integration test helper — provision a fresh test Odoo database.
 *
 * Sequence:
 *  1. Create the test database via /web/database/create (form-encoded POST,
 *     retried up to 3 times on network error with 5-second back-off).
 *  2. Authenticate as the database admin via /web/session/authenticate.
 *  3. Create a dedicated test user via execute_kw on res.users.
 *  4. Generate an API key for the test user via res.users.api_key_create.
 *     Falls back to the plain password when the method is unavailable (older Odoo).
 *
 * Uses native fetch (Node 22). No new npm dependencies.
 */

// Minimal ambient declaration — avoids @types/node dependency (matches src/ pattern).
declare const process: { stderr: { write: (data: string) => boolean } };

/** Credentials returned by provisionTestOdoo and consumed by integration tests. */
export interface TestCredentials {
  dbName: string;
  username: string;
  apiKey: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

/** Master password as shipped in the Odoo Docker image and set in docker-compose.test.yml. */
const MASTER_PASSWORD = 'admin';

/** Database name created for integration tests. */
const TEST_DB = 'test_mcp';

/** Admin login/password seeded into the test database on creation. */
const ADMIN_LOGIN = 'admin';
const ADMIN_PASSWORD = 'test_admin';

/** Dedicated MCP test user. */
const MCP_USER_LOGIN = 'mcp_test';
const MCP_USER_PASSWORD = 'mcp_test_pw';
const MCP_USER_NAME = 'MCP Test User';
const MCP_KEY_DESCRIPTION = 'mcp-integration-test';

const RETRY_LIMIT = 3;
const RETRY_BACKOFF_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal JSON-RPC 2.0 POST to an Odoo endpoint.
 * Returns the `result` field of the response envelope.
 * Throws when the envelope contains an `error` field.
 */
async function odooJsonRpc(
  url: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionId) {
    headers.Cookie = `session_id=${sessionId}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      id: Math.floor(Math.random() * 100_000),
      params,
    }),
  });

  const json = (await response.json()) as {
    result?: unknown;
    error?: { message: string; data?: { message?: string; name?: string } };
  };

  if (json.error) {
    const detail = json.error.data?.message ?? json.error.message;
    const name = json.error.data?.name ?? '';
    const err = new Error(`Odoo RPC error: ${detail}`);
    // Attach the error name so callers can distinguish method-not-found.
    (err as Error & { odooName: string }).odooName = name;
    throw err;
  }

  return json.result;
}

/**
 * Convenience wrapper: call execute_kw on model/method.
 * `args` = positional args; `kwargs` = keyword args.
 */
async function executeKw(
  baseUrl: string,
  db: string,
  uid: number,
  password: string,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> {
  return odooJsonRpc(
    `${baseUrl}/web/dataset/call_kw`,
    {
      model,
      method,
      args,
      kwargs,
      // Legacy /web/dataset/call_kw expects these extra top-level fields.
      // They mirror what Odoo's web client sends.
    },
    sessionId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provision a fresh Odoo test database and return usable `TestCredentials`.
 *
 * @param baseUrl  Base URL of the Odoo instance, e.g. `http://localhost:8069`.
 */
export async function provisionTestOdoo(baseUrl: string): Promise<TestCredentials> {
  // ── Step 1: Create the test database ────────────────────────────────────────
  // The /web/database/create endpoint expects an application/x-www-form-urlencoded
  // body and accepts both HTTP 200 and HTTP 3xx (redirect) as success.  Retry up
  // to RETRY_LIMIT times on network-level errors.
  let createAttempt = 0;
  while (true) {
    createAttempt++;
    try {
      const body = new URLSearchParams({
        master_pwd: MASTER_PASSWORD,
        name: TEST_DB,
        lang: 'en_US',
        password: ADMIN_PASSWORD,
        login: ADMIN_LOGIN,
        country_code: 'us',
        phone: '',
      });

      const response = await fetch(`${baseUrl}/web/database/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        // Do not follow redirect — we treat any non-5xx response as success.
        redirect: 'manual',
      });

      // 200 OK or 3xx redirect both indicate the DB was created (or already exists).
      if (response.status < 500) {
        process.stderr.write(
          `${JSON.stringify({ event: 'db_created', db: TEST_DB, status: response.status })}\n`,
        );
        break;
      }

      // 5xx response — treat as retriable.
      throw new Error(`Database creation returned HTTP ${response.status}`);
    } catch (err: unknown) {
      if (createAttempt >= RETRY_LIMIT) {
        throw new Error(
          `Failed to create test database after ${RETRY_LIMIT} attempts: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      process.stderr.write(
        `${JSON.stringify({
          event: 'db_create_retry',
          attempt: createAttempt,
          error: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
      await sleep(RETRY_BACKOFF_MS);
    }
  }

  // ── Step 2: Authenticate as admin ───────────────────────────────────────────
  const authResult = (await odooJsonRpc(`${baseUrl}/web/session/authenticate`, {
    db: TEST_DB,
    login: ADMIN_LOGIN,
    password: ADMIN_PASSWORD,
  })) as { uid: number; session_id: string };

  const adminUid: number = authResult.uid;
  const sessionId: string = authResult.session_id;

  // ── Step 3: Create the MCP test user ────────────────────────────────────────
  // execute_kw via /web/dataset/call_kw, authenticated with the admin session.
  const newUserId = (await executeKw(
    baseUrl,
    TEST_DB,
    adminUid,
    ADMIN_PASSWORD,
    'res.users',
    'create',
    [{ name: MCP_USER_NAME, login: MCP_USER_LOGIN, password: MCP_USER_PASSWORD }],
    {},
    sessionId,
  )) as number;

  // ── Step 4: Generate an API key for the test user ────────────────────────────
  // res.users.api_key_create was added in Odoo 17. Fall back to the plain
  // password when the method is unavailable (older builds or CE editions that
  // haven't backported the endpoint).
  let apiKey: string;
  try {
    const keyResult = await executeKw(
      baseUrl,
      TEST_DB,
      adminUid,
      ADMIN_PASSWORD,
      'res.users',
      'api_key_create',
      [newUserId, { description: MCP_KEY_DESCRIPTION }],
      {},
      sessionId,
    );
    // api_key_create returns the raw key string on success.
    apiKey = keyResult as string;
  } catch (err: unknown) {
    const name = (err as Error & { odooName?: string }).odooName ?? '';
    // Method-not-found errors surface as AttributeError or similar from Odoo.
    const isMethodNotFound =
      name.includes('AttributeError') ||
      name.includes('MethodNotFound') ||
      name.includes('NotImplemented');
    if (isMethodNotFound) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'api_key_fallback',
          reason: 'api_key_create not available',
        })}\n`,
      );
      apiKey = MCP_USER_PASSWORD;
    } else {
      throw err;
    }
  }

  return { dbName: TEST_DB, username: MCP_USER_LOGIN, apiKey };
}
