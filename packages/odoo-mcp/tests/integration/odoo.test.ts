/**
 * Real-Odoo integration test suite (T-14).
 *
 * Requires:
 *   - docker-compose.test.yml up (Odoo listening on http://localhost:8069)
 *   - pnpm -r build (produces packages/odoo-mcp/dist/bin.js)
 *
 * Run via: pnpm test:integration (not pnpm test)
 *
 * Covers: US-7 AC-2, AC-3, AC-4, AC-5, AC-6, AC-7
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';

import { provisionTestOdoo, type TestCredentials } from './helpers/odoo-setup.js';
import { spawnHttpServer } from './helpers/spawn-http-server.js';
import { waitForOdoo } from './helpers/wait-for-odoo.js';

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_URL = process.env['ODOO_TEST_URL'] ?? 'http://localhost:8069';

// Resolved once at module load time — works from any cwd because integration
// tests are run with `pnpm test:integration` from the monorepo root.
const BIN_PATH = path.resolve(process.cwd(), 'packages/odoo-mcp/dist/bin.js');

// ── Shared state ───────────────────────────────────────────────────────────

let creds: TestCredentials;

// ── stdio-mode suite ───────────────────────────────────────────────────────

describe('stdio transport', () => {
  let stdioClient: Client;

  beforeAll(async () => {
    // AC-7: contextualise failures with which step failed.
    try {
      // Step 1 — wait for Odoo to be healthy (up to 2 min).
      await waitForOdoo(BASE_URL, 120_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[T-14/beforeAll] waitForOdoo failed: ${msg}`);
    }

    try {
      // Step 2 — provision test DB + credentials (shared across both suites).
      creds = await provisionTestOdoo(BASE_URL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[T-14/beforeAll] provisionTestOdoo failed: ${msg}`);
    }

    try {
      // Step 3 — connect via stdio transport (spawns bin.js as child process).
      const transport = new StdioClientTransport({
        command: 'node',
        args: [BIN_PATH],
        env: {
          ODOO_URL: BASE_URL,
          ODOO_DB: creds.dbName,
          ODOO_USERNAME: creds.username,
          ODOO_API_KEY: creds.apiKey,
        },
      });
      stdioClient = new Client({ name: 'test-client-stdio', version: '0.0.1' });
      await stdioClient.connect(transport);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[T-14/beforeAll] StdioClientTransport connect failed: ${msg}`);
    }
  }, 180_000 /* 3-minute timeout for Odoo startup + transport connect */);

  afterAll(async () => {
    // client.close() sends CloseSession and kills the spawned child process.
    await stdioClient?.close();
  });

  // AC-2 ────────────────────────────────────────────────────────────────────
  it('MCP initialize handshake succeeds', () => {
    // client.connect() already performed the initialize handshake.
    const info = stdioClient.getServerVersion();
    expect(info?.name).toBe('odoo-mcp');
  });

  // AC-2 ────────────────────────────────────────────────────────────────────
  it('tools/list returns exactly 10 tools', async () => {
    const { tools } = await stdioClient.listTools();
    expect(tools).toHaveLength(10);
  });

  // AC-2, AC-5 ──────────────────────────────────────────────────────────────
  it('odoo_search_read on res.partner returns a JSON array', async () => {
    // No domain filter — relies on the test DB seeding at least one partner
    // (Odoo always creates the company record on DB creation).
    const result = await stdioClient.callTool({
      name: 'odoo_search_read',
      arguments: { model: 'res.partner' },
    });

    expect(result.isError).toBeFalsy();

    // AC-2: content[0].text must be valid JSON that parses as an array.
    const content = result.content as Array<{ text: string }>;
    const parsed: unknown = JSON.parse(content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });

  // AC-3 ────────────────────────────────────────────────────────────────────
  it('startup with wrong ODOO_API_KEY causes connect() to reject', async () => {
    const badTransport = new StdioClientTransport({
      command: 'node',
      args: [BIN_PATH],
      env: {
        ODOO_URL: BASE_URL,
        ODOO_DB: creds.dbName,
        ODOO_USERNAME: creds.username,
        ODOO_API_KEY: 'definitely-wrong-key',
      },
    });
    const badClient = new Client({ name: 'bad-creds-test', version: '0.0.1' });

    // bin.js exits with code 1 on auth failure, which causes StdioClientTransport
    // to reject the connect() promise before the MCP handshake completes (AC-3).
    await expect(badClient.connect(badTransport)).rejects.toThrow();
  });
});

// ── http-mode suite ────────────────────────────────────────────────────────

describe('http transport', () => {
  let httpClient: Client;
  let httpCleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // creds was populated by the stdio beforeAll (suites run sequentially).
    // If it's missing, the stdio suite's beforeAll already threw — skip gracefully.
    if (!creds) {
      return;
    }

    try {
      // Spawn bin.js in MODE=http on a random free port.
      const { port, bearerToken, cleanup } = await spawnHttpServer({
        ODOO_URL: BASE_URL,
        ODOO_DB: creds.dbName,
        ODOO_USERNAME: creds.username,
        ODOO_API_KEY: creds.apiKey,
      });

      httpCleanup = cleanup;

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${bearerToken}` },
          },
        },
      );

      httpClient = new Client({ name: 'test-client-http', version: '0.0.1' });
      await httpClient.connect(transport);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[T-14/http/beforeAll] HTTP transport setup failed: ${msg}`);
    }
  }, 60_000 /* server spawn + connect timeout */);

  afterAll(async () => {
    await httpClient?.close();
    await httpCleanup?.();
  });

  // AC-4, AC-6 ──────────────────────────────────────────────────────────────
  it('MCP initialize handshake succeeds over HTTP', () => {
    if (!httpClient) return; // creds absent — already reported by stdio suite
    const info = httpClient.getServerVersion();
    expect(info?.name).toBe('odoo-mcp');
  });

  it('tools/list returns exactly 10 tools over HTTP', async () => {
    if (!httpClient) return;
    const { tools } = await httpClient.listTools();
    expect(tools).toHaveLength(10);
  });

  it('odoo_search_read on res.partner returns a JSON array over HTTP', async () => {
    if (!httpClient) return;
    const result = await httpClient.callTool({
      name: 'odoo_search_read',
      arguments: { model: 'res.partner' },
    });

    expect(result.isError).toBeFalsy();

    const content = result.content as Array<{ text: string }>;
    const parsed: unknown = JSON.parse(content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
