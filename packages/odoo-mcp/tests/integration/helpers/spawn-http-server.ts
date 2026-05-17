/**
 * Integration test helper — spawn an HTTP-mode MCP server from dist/bin.js.
 *
 * Readiness strategy: parse stderr line-by-line via node:readline and resolve
 * as soon as a line is valid JSON with `event === "startup"`. This is reliable
 * because logger.startup() always writes before the HTTP transport is fully
 * bound (see bin.ts step 3 → step 4 ordering).
 *
 * Uses: node:child_process, node:path, node:readline, node:net, node:os, node:fs
 * No @types/node — each node: import is @ts-ignore'd per project convention.
 */

// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { spawn } from 'node:child_process';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { existsSync } from 'node:fs';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { unlink } from 'node:fs/promises';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { createServer as createNetServer } from 'node:net';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { tmpdir } from 'node:os';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { resolve as pathResolve } from 'node:path';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { createInterface } from 'node:readline';

export interface SpawnedServer {
  port: number;
  adminPassword: string;
  userStorePath: string;
  cleanup: () => Promise<void>;
}

export interface OdooEnv {
  ODOO_URL: string;
  ODOO_DB: string;
  ODOO_USERNAME: string;
  ODOO_API_KEY: string;
}

export interface SpawnOptions {
  port?: number;
  adminPassword?: string;
  encryptionKey?: string;
  userStorePath?: string;
}

/**
 * Pick a random unused TCP port by binding to port 0 and reading the OS
 * assignment, then releasing it. There is a small TOCTOU window, but this is
 * acceptable in local test environments.
 */
function findUnusedPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    // @ts-ignore — net.Server type requires @types/node
    const srv = createNetServer();
    // @ts-ignore — server.listen overloads require @types/node
    srv.listen(0, '127.0.0.1', () => {
      // @ts-ignore — server.address() return type requires @types/node
      const addr = srv.address() as { port: number };
      const chosen = addr.port;
      // @ts-ignore — server.close callback type requires @types/node
      srv.close((err?: Error) => {
        if (err) reject(err);
        else resolve(chosen);
      });
    });
    // @ts-ignore — server.on('error') type requires @types/node
    srv.on('error', (err: Error) => reject(err));
  });
}

/** Generate a random hex string of the given byte length (result is 2*bytes hex chars). */
function randomToken(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  // @ts-ignore — crypto.getRandomValues is available in Node 19+; fallback below
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build a cleanup function for a spawned child process.
 * Sends SIGTERM, then SIGKILL after 5 s if the process hasn't exited.
 */
// @ts-ignore — ChildProcess type requires @types/node
function makeCleanup(proc: ReturnType<typeof spawn>): () => Promise<void> {
  return (): Promise<void> => {
    return new Promise<void>((resolve) => {
      // @ts-ignore — proc.exitCode type requires @types/node
      if ((proc.exitCode as number | null) !== null) {
        // Process already exited — nothing to do.
        resolve();
        return;
      }

      // @ts-ignore — proc.kill type requires @types/node
      proc.kill('SIGTERM');

      const timeout = setTimeout(() => {
        // @ts-ignore — proc.exitCode / proc.kill types require @types/node
        if ((proc.exitCode as number | null) === null) {
          // @ts-ignore
          proc.kill('SIGKILL');
        }
        resolve();
      }, 5_000);

      // @ts-ignore — proc.once type requires @types/node
      (proc as { once: (event: string, cb: () => void) => void }).once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  };
}

/**
 * Spawn an HTTP-mode MCP server from `packages/odoo-mcp/dist/bin.js`.
 *
 * Resolves once the server emits `{"event":"startup",...}` on stderr —
 * indicating the HTTP transport is bound and ready.
 *
 * @param odooEnv  Odoo connection environment variables for the child process.
 * @param options  Optional port, adminPassword, encryptionKey, userStorePath overrides.
 * @returns        Resolved port, adminPassword, userStorePath, and a cleanup function.
 * @throws         If dist/bin.js is not found (run `pnpm -r build` first).
 */
export async function spawnHttpServer(
  odooEnv: OdooEnv,
  options?: SpawnOptions,
): Promise<SpawnedServer> {
  // @ts-ignore — process.cwd() return type requires @types/node
  const binPath: string = pathResolve(process.cwd() as string, 'packages/odoo-mcp/dist/bin.js');

  if (!existsSync(binPath)) {
    throw new Error(
      `dist/bin.js not found — run \`pnpm -r build\` before integration tests (looked at ${binPath})`,
    );
  }

  const port: number = options?.port ?? (await findUnusedPort());
  const adminPassword: string = options?.adminPassword ?? randomToken(16);
  // Generate a 32-byte base64 key (all 0xAB) if not provided.
  const encryptionKey: string =
    options?.encryptionKey ??
    // @ts-ignore — Buffer is a Node.js global
    Buffer.alloc(32)
      .fill(0xab)
      .toString('base64');
  const userStorePath: string =
    // @ts-ignore — tmpdir is imported above
    options?.userStorePath ?? `${tmpdir()}/odoo-mcp-test-${randomToken(8)}.json`;

  const env: Record<string, string | undefined> = {
    // @ts-ignore — process.env type requires @types/node
    ...(process.env as Record<string, string | undefined>),
    ...odooEnv,
    MODE: 'http',
    MCP_PORT: String(port),
    MCP_ENCRYPTION_KEY: encryptionKey,
    MCP_ADMIN_PASSWORD: adminPassword,
    MCP_USER_STORE_PATH: userStorePath,
  };

  // @ts-ignore — spawn return type requires @types/node
  const proc = spawn('node', [binPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const procCleanup = makeCleanup(proc);

  // Cleanup: kill process + best-effort remove temp user store file.
  const cleanup = async (): Promise<void> => {
    await procCleanup();
    try {
      await unlink(userStorePath);
    } catch {
      // best-effort — file may not exist
    }
  };

  // Accumulate all stderr output so it can be attached to thrown errors.
  let stderrBuffer = '';
  // @ts-ignore — proc.stderr event handler types require @types/node
  (proc.stderr as { on: (event: string, cb: (chunk: Buffer) => void) => void }).on(
    'data',
    (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    },
  );

  return new Promise<SpawnedServer>((resolve, reject) => {
    // @ts-ignore — createInterface options type requires @types/node
    const rl = createInterface({ input: proc.stderr, crlfDelay: Number.POSITIVE_INFINITY });

    // @ts-ignore — readline Interface event types require @types/node
    (rl as { on: (event: string, cb: (line: string) => void) => void }).on(
      'line',
      (line: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // Not JSON — skip
        }

        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          (parsed as Record<string, unknown>).event === 'startup'
        ) {
          // @ts-ignore — rl.close type requires @types/node
          (rl as { close: () => void }).close();
          resolve({ port, adminPassword, userStorePath, cleanup });
        }
      },
    );

    // @ts-ignore — proc.on type requires @types/node
    (proc as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on(
      'error',
      (err: Error) => {
        // @ts-ignore
        (rl as { close: () => void }).close();
        reject(
          new Error(`Failed to spawn bin.js: ${err.message}\nstderr collected:\n${stderrBuffer}`),
        );
      },
    );

    // @ts-ignore — proc.on exit types require @types/node
    (proc as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on(
      'exit',
      (code: number | null, signal: string | null) => {
        // @ts-ignore
        (rl as { close: () => void }).close();
        reject(
          new Error(
            `Server exited early before startup event (code=${code}, signal=${signal}).\n` +
              `stderr collected:\n${stderrBuffer}`,
          ),
        );
      },
    );
  });
}

/**
 * Run steps 2–7 of the OAuth dance to obtain an access_token for /mcp.
 *
 * Precondition: server is already spawned and running at the given port.
 * The caller must have already set up the admin allowlist entry (step 2),
 * OR this helper will do it if `email` and `adminPassword` are provided.
 *
 * Steps:
 *   2. Admin allow (POST /admin/users)
 *   3. DCR (POST /oauth/register)
 *   4. Generate PKCE verifier + challenge
 *   5. GET /oauth/authorize (expect consent page HTML)
 *   6. POST /oauth/authorize with credentials (capture 302 redirect code)
 *   7. POST /oauth/token (exchange code for access_token)
 *
 * @returns access_token string (64 hex chars)
 */
export async function obtainAccessToken(
  port: number,
  adminPassword: string,
  odooEnv: Pick<OdooEnv, 'ODOO_USERNAME' | 'ODOO_API_KEY'>,
): Promise<string> {
  const base = `http://127.0.0.1:${port}`;
  const redirectUri = 'http://127.0.0.1:9999/callback';

  // Step 2: Admin allow
  const allowResp = await fetch(`${base}/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminPassword}`,
    },
    body: JSON.stringify({ email: odooEnv.ODOO_USERNAME }),
  });
  if (allowResp.status !== 200 && allowResp.status !== 201) {
    const body = await allowResp.text();
    throw new Error(`Admin allow failed: ${allowResp.status} ${body}`);
  }

  // Step 3: DCR
  const dcrResp = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  });
  if (dcrResp.status !== 201) {
    const body = await dcrResp.text();
    throw new Error(`DCR failed: ${dcrResp.status} ${body}`);
  }
  const dcrData = (await dcrResp.json()) as { client_id: string };
  const clientId = dcrData.client_id;

  // Step 4: PKCE
  // @ts-ignore — crypto.getRandomValues and subtle are available in Node 19+
  const verifierBytes = new Uint8Array(32);
  // @ts-ignore — crypto.getRandomValues
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // SHA-256 challenge via SubtleCrypto
  // @ts-ignore — crypto.subtle is available in Node 19+
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Step 5: GET authorize
  const authUrl = `${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&state=teststate`;

  const getResp = await fetch(authUrl);
  if (getResp.status !== 200) {
    const body = await getResp.text();
    throw new Error(`GET /oauth/authorize failed: ${getResp.status} ${body}`);
  }

  // Step 6: POST authorize with credentials
  const postResp = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(odooEnv.ODOO_USERNAME)}&api_key=${encodeURIComponent(odooEnv.ODOO_API_KEY)}`,
    redirect: 'manual',
  });
  if (postResp.status !== 302) {
    const body = await postResp.text();
    throw new Error(`POST /oauth/authorize expected 302, got: ${postResp.status} ${body}`);
  }
  const location = postResp.headers.get('location') ?? '';
  const locationUrl = new URL(location);
  const code = locationUrl.searchParams.get('code');
  if (!code) {
    throw new Error(`No code in redirect Location: ${location}`);
  }

  // Step 7: Token exchange
  const tokenResp = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${encodeURIComponent(clientId)}&code_verifier=${encodeURIComponent(codeVerifier)}`,
  });
  if (tokenResp.status !== 200) {
    const body = await tokenResp.text();
    throw new Error(`Token exchange failed: ${tokenResp.status} ${body}`);
  }
  const tokenData = (await tokenResp.json()) as {
    access_token: string;
    token_type: string;
    scope: string;
  };
  if (!tokenData.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}
