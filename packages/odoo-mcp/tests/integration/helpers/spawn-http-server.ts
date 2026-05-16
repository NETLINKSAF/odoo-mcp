/**
 * Integration test helper — spawn an HTTP-mode MCP server from dist/bin.js.
 *
 * Readiness strategy: parse stderr line-by-line via node:readline and resolve
 * as soon as a line is valid JSON with `event === "startup"`. This is reliable
 * because logger.startup() always writes before the HTTP transport is fully
 * bound (see bin.ts step 3 → step 4 ordering).
 *
 * Uses: node:child_process, node:path, node:readline, node:net
 * No @types/node — each node: import is @ts-ignore'd per project convention.
 */

// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { spawn } from 'node:child_process';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { existsSync } from 'node:fs';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { createServer as createNetServer } from 'node:net';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { resolve as pathResolve } from 'node:path';
// @ts-ignore — @types/node is not installed; resolves correctly at Node.js runtime
import { createInterface } from 'node:readline';

export interface SpawnedServer {
  port: number;
  bearerToken: string;
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
  bearerToken?: string;
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

/** Generate a random alphanumeric bearer token (not cryptographically secret). */
function randomToken(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
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
 * @param options  Optional port and bearer token overrides.
 * @returns        Resolved port, bearer token, and a cleanup function.
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
  const bearerToken: string = options?.bearerToken ?? randomToken();

  const env: Record<string, string | undefined> = {
    // @ts-ignore — process.env type requires @types/node
    ...(process.env as Record<string, string | undefined>),
    ...odooEnv,
    MODE: 'http',
    MCP_PORT: String(port),
    MCP_BEARER_TOKEN: bearerToken,
  };

  // @ts-ignore — spawn return type requires @types/node
  const proc = spawn('node', [binPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const cleanup = makeCleanup(proc);

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
          resolve({ port, bearerToken, cleanup });
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
