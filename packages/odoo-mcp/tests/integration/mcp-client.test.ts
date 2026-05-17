/**
 * MCP client contract integration test (T-15).
 *
 * Guards against the v0.1.0 regression where every tool returned an empty
 * `inputSchema.properties` object. Both stdio and HTTP transport paths are
 * exercised so that the bearer-token middleware is also covered (US-8 AC-5).
 *
 * Prerequisites:
 *   - Odoo running at ODOO_TEST_URL (default: http://localhost:8069)
 *   - dist/bin.js built (`pnpm -r build`)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { waitForOdoo } from './helpers/wait-for-odoo.js';
import { provisionTestOdoo, type TestCredentials } from './helpers/odoo-setup.js';
import {
  obtainAccessToken,
  spawnHttpServer,
  type SpawnedServer,
} from './helpers/spawn-http-server.js';

// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
const __filename = fileURLToPath(import.meta.url);
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
const __dirname = path.dirname(__filename);

const BASE_URL = (typeof process !== 'undefined' && (process as { env?: Record<string, string | undefined> }).env?.['ODOO_TEST_URL']) ?? 'http://localhost:8069';

/** Resolved once for both suites. */
let creds: TestCredentials;

beforeAll(async () => {
  await waitForOdoo(BASE_URL, 120_000);
  creds = await provisionTestOdoo(BASE_URL);
}, 180_000);

// ─────────────────────────────────────────────────────────────────────────────
// Shared assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that all 10 registered tools expose a non-empty inputSchema.properties.
 *
 * This is the primary regression guard for the v0.1.0 bug where every tool
 * shipped with `inputSchema: {}` (properties missing entirely).
 */
async function assertAllToolsHavePopulatedSchemas(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools, 'tools/list should return exactly 10 tools').toHaveLength(10);
  for (const tool of tools) {
    const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(props, `tool "${tool.name}" is missing inputSchema.properties`).toBeDefined();
    expect(
      Object.keys(props!).length,
      `tool "${tool.name}" has empty inputSchema.properties`,
    ).toBeGreaterThan(0);
  }
}

/**
 * Assert that odoo_fields_get returns a non-empty JSON object for res.partner.
 */
async function assertFieldsGetReturnsData(client: Client): Promise<void> {
  const result = await client.callTool({
    name: 'odoo_fields_get',
    arguments: { model: 'res.partner' },
  });
  expect(result.isError, 'odoo_fields_get should not return an error').toBeFalsy();
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]?.text, 'response content should be non-empty').toBeTruthy();
  const parsed = JSON.parse(content[0].text) as unknown;
  expect(typeof parsed).toBe('object');
  expect(Object.keys(parsed as object).length).toBeGreaterThan(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// stdio transport suite
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP client contract — stdio transport', () => {
  let client: Client;

  beforeAll(async () => {
    // bin.js path: packages/odoo-mcp/dist/bin.js relative to repo root.
    const binPath = path.resolve(__dirname, '..', '..', 'dist', 'bin.js');

    // StdioClientTransport spawns the child process itself via command+args.
    // MODE env var is intentionally omitted — defaults to stdio.
    const transport = new StdioClientTransport({
      command: 'node',
      args: [binPath],
      env: {
        // @ts-ignore — process.env type requires @types/node
        ...(process.env as Record<string, string | undefined>),
        ODOO_URL: BASE_URL,
        ODOO_DB: creds.dbName,
        ODOO_USERNAME: creds.username,
        ODOO_API_KEY: creds.apiKey,
        // Omit MODE → defaults to stdio
      },
    });

    client = new Client({ name: 'mcp-contract-stdio', version: '0.0.1' }, {});
    await client.connect(transport);
  }, 60_000);

  // client.close() also terminates the spawned child process.
  afterAll(async () => {
    await client?.close();
  });

  it(
    'all 10 tools have non-empty inputSchema.properties (v0.1.0 regression guard)',
    async () => {
      await assertAllToolsHavePopulatedSchemas(client);
    },
  );

  it('odoo_fields_get returns non-empty valid JSON for res.partner', async () => {
    await assertFieldsGetReturnsData(client);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP transport suite
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP client contract — http transport', () => {
  // Fixed port for this suite; unlikely to conflict with other parallel tests.
  const PORT = 13001;

  let spawned: SpawnedServer;
  let client: Client;

  beforeAll(async () => {
    spawned = await spawnHttpServer(
      {
        ODOO_URL: BASE_URL,
        ODOO_DB: creds.dbName,
        ODOO_USERNAME: creds.username,
        ODOO_API_KEY: creds.apiKey,
      },
      { port: PORT },
    );

    // Obtain an OAuth access token via the full PKCE dance.
    const accessToken = await obtainAccessToken(spawned.port, spawned.adminPassword, {
      ODOO_USERNAME: creds.username,
      ODOO_API_KEY: creds.apiKey,
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${spawned.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } },
    );

    client = new Client({ name: 'mcp-contract-http', version: '0.0.1' }, {});
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await spawned?.cleanup();
  });

  it(
    'all 10 tools have non-empty inputSchema.properties (v0.1.0 regression guard)',
    async () => {
      await assertAllToolsHavePopulatedSchemas(client);
    },
  );

  it('odoo_fields_get returns non-empty valid JSON for res.partner', async () => {
    await assertFieldsGetReturnsData(client);
  });

  it('connection with invalid token is rejected (US-8 AC-5)', async () => {
    const badTransport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${spawned.port}/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer invalid-token-not-in-store' } } },
    );
    const badClient = new Client({ name: 'bad-client', version: '0.0.1' }, {});
    await expect(badClient.connect(badTransport)).rejects.toThrow();
  });
});
