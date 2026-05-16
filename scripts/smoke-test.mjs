// Manual MCP smoke test for @netlinksinc/odoo-mcp.
//
// Spawns the compiled server (`packages/odoo-mcp/dist/bin.js`), speaks
// the MCP stdio JSON-RPC protocol, and asserts that the server reports
// the expected serverInfo and exactly 10 tools.
//
// Required environment variables (forwarded to the spawned process):
//   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY
//
// Usage: node scripts/smoke-test.mjs
//
// Exit codes: 0 on pass; 1 on any assertion failure (the raw response is
// printed to stderr before exiting).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const binPath = path.resolve('packages/odoo-mcp/dist/bin.js');

// Pre-flight: ensure the compiled binary is present.
if (!existsSync(binPath)) {
  process.stderr.write(
    `smoke test failed: compiled bin not found at ${binPath}. Run \`pnpm -r build\` first.\n`,
  );
  process.exit(1);
}

// Spawn the MCP server process.
const proc = spawn('node', [binPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

// Accumulate stderr for diagnostics, and tee it to our own stderr (AC-2).
let stderrAccumulated = '';
proc.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderrAccumulated += text;
  process.stderr.write(chunk);
});

// Overall 30-second timeout — enough time for Odoo auth + probe.
const timeout = setTimeout(() => {
  process.stderr.write('smoke test failed: timed out waiting for server responses (30s).\n');
  if (stderrAccumulated) {
    process.stderr.write(`server stderr:\n${stderrAccumulated}\n`);
  }
  proc.kill('SIGTERM');
  process.exit(1);
}, 30_000);

// Fail fast if the subprocess exits before all responses are received.
proc.on('exit', (code) => {
  if (pending.size > 0) {
    clearTimeout(timeout);
    process.stderr.write(
      `smoke test failed: server process exited (code ${code}) before all responses arrived.\n`,
    );
    if (stderrAccumulated) {
      process.stderr.write(`server stderr:\n${stderrAccumulated}\n`);
    }
    process.exit(1);
  }
});

// Read stdout line-by-line using readline.
const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY });

// Pending response map: id -> { resolve, reject }
const pending = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Non-JSON line — ignore (e.g. server startup noise).
    return;
  }

  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

/**
 * Send a JSON-RPC request to the server and return a promise that resolves
 * with the matching response object.
 */
function sendRequest(request) {
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

async function main() {
  // Step 1: send initialize.
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.1.0' },
    },
  };

  const initResponse = await sendRequest(initialize);

  // Step 2: send tools/list.
  const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const toolsListResponse = await sendRequest(toolsList);

  // Assertions.
  const serverName = initResponse?.result?.serverInfo?.name;
  const toolCount = toolsListResponse?.result?.tools?.length;

  const failures = [];

  if (serverName !== 'odoo-mcp') {
    failures.push(`expected serverInfo.name === 'odoo-mcp', got ${JSON.stringify(serverName)}`);
  }

  if (toolCount !== 10) {
    failures.push(`expected tools.length === 10, got ${JSON.stringify(toolCount)}`);
  }

  if (failures.length > 0) {
    process.stderr.write('smoke test failed:\n');
    for (const f of failures) {
      process.stderr.write(`  - ${f}\n`);
    }
    process.stderr.write('\nraw initialize response:\n');
    process.stderr.write(`${JSON.stringify(initResponse, null, 2)}\n`);
    process.stderr.write('\nraw tools/list response:\n');
    process.stderr.write(`${JSON.stringify(toolsListResponse, null, 2)}\n`);
    proc.kill('SIGTERM');
    clearTimeout(timeout);
    process.exit(1);
  }

  process.stdout.write('smoke test passed\n');
  proc.kill('SIGTERM');
  clearTimeout(timeout);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`smoke test failed with unexpected error: ${err.message}\n`);
  proc.kill('SIGTERM');
  clearTimeout(timeout);
  process.exit(1);
});
