#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OdooClient } from '@netlinksinc/odoo-client';
import { createAdminEndpoints } from './admin.js';
import { createClientCache } from './client-cache.js';
import type { ClientCache } from './client-cache.js';
import { loadConfig } from './config.js';
import { createEncryptionService } from './encryption.js';
import { requestContextStorage, startHttpTransport } from './http-transport.js';
import { createOAuthEndpoints } from './oauth.js';
import { createOdooMcpServer } from './server.js';
import type { ClientResolver, HealthPayload } from './types.js';
import { createUserStore } from './user-store.js';

// Minimal ambient declaration — avoids @types/node dependency.
// Includes process.on so SIGTERM/SIGINT handlers can be registered.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
  on: (event: string, handler: () => Promise<void>) => void;
};

/** NFR-3: If startup does not complete within 30 s, exit with code 1. */
const STARTUP_TIMEOUT_MS = 30_000;

(async () => {
  // Subcommand dispatch — must happen before server startup.
  const subcommand = process.argv[2];
  if (subcommand === 'users') {
    const { runUsersCommand } = await import('./cli-users.js');
    await runUsersCommand(process.argv.slice(3));
    process.exit(0);
  }
  if (subcommand === 'auth') {
    const { runAuthCommand } = await import('./cli-auth.js');
    await runAuthCommand(process.argv.slice(3));
    process.exit(0);
  }

  // Module-level ref to clientCache so shutdown can call stopSweep.
  let clientCache: ClientCache | undefined;

  try {
    // 1. Load and validate configuration (exits 1 itself on invalid env).
    const config = loadConfig();

    // 2. Wire all subsystems together — race against the startup timeout.
    //    If createOdooMcpServer hangs (e.g. Odoo unreachable), the timeout
    //    fires and the process exits with startup_error / code 1 (NFR-3).
    let serverResult: Awaited<ReturnType<typeof createOdooMcpServer>>;

    if (config.mode === 'http') {
      // HTTP mode: build OAuth subsystems BEFORE createOdooMcpServer so the
      // clientResolver closure can capture them, then pass clientResolver in.

      // biome-ignore lint/style/noNonNullAssertion: config.http guaranteed defined when mode='http' (validated in loadConfig)
      const httpCfg = config.http!;
      const encryptionService = createEncryptionService(
        httpCfg.encryptionKey as unknown as Parameters<typeof createEncryptionService>[0],
      );
      const userStore = createUserStore({
        filePath: httpCfg.userStorePath,
        encryptionKey: httpCfg.encryptionKey as unknown as Parameters<
          typeof createUserStore
        >[0]['encryptionKey'],
        odooUrl: config.odoo.url,
        odooDb: config.odoo.db,
      });
      await userStore.load();
      clientCache = createClientCache({
        maxSize: 100,
        idleTtlMs: 30 * 60_000,
        sweepIntervalMs: 5 * 60_000,
      });
      clientCache.startSweep();

      // Per-request client resolver: looks up the authenticated user from ALS,
      // returns a cached OdooClient or builds a new one from stored credentials.
      const clientResolver: ClientResolver = async () => {
        const ctx = requestContextStorage.getStore();
        const email = ctx?.user_id;
        if (!email) throw new Error('no authenticated user in request context');
        // biome-ignore lint/style/noNonNullAssertion: clientCache is always set in HTTP mode before this resolver is invoked
        const cached = clientCache!.get(email);
        if (cached) return { client: cached.client, session: cached.session };
        const creds = userStore.getCredentials(email);
        if (!creds) throw new Error(`no credentials found for user ${email}`);
        const client = new OdooClient({
          ...config.odoo,
          username: creds.username,
          apiKey: creds.apiKey,
        });
        const session = await client.authenticate();
        // biome-ignore lint/style/noNonNullAssertion: clientCache is always set in HTTP mode before this resolver is invoked
        clientCache!.set(email, { client, session, lastUsedAt: Date.now() });
        return { client, session };
      };

      serverResult = await Promise.race([
        createOdooMcpServer({
          odooConfig: config.odoo,
          logFile: config.logFile,
          clientResolver,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('startup_timeout')), STARTUP_TIMEOUT_MS),
        ),
      ]);

      const { server, logger, probeOk, probeClient } = serverResult;

      // 3. Log startup info before connecting (AC-3 — startup BEFORE connect).
      logger.startup({
        odoo_url: config.odoo.url,
        odoo_db: config.odoo.db,
        odoo_username: config.odoo.username,
        mode: config.mode,
      });

      const healthPayload: HealthPayload = {
        mode: 'http',
        odoo_url: config.odoo.url,
        odoo_db: config.odoo.db,
        started_at: new Date().toISOString(),
        probe_ok: probeOk,
      };

      const oauthEndpoints = createOAuthEndpoints({
        publicUrl: httpCfg.publicUrl,
        port: httpCfg.port,
        odooUrl: config.odoo.url,
        odooDb: config.odoo.db,
        userStore,
        probeClient,
        encryptionService,
      });
      const adminEndpoints = createAdminEndpoints({
        adminPassword: httpCfg.adminPassword,
        userStore,
        // biome-ignore lint/style/noNonNullAssertion: clientCache is always set in HTTP mode
        clientCache: clientCache!,
      });
      const { close } = await startHttpTransport({
        port: httpCfg.port,
        trustProxy: httpCfg.trustProxy,
        server,
        logger,
        healthPayload,
        oauthEndpoints,
        adminEndpoints,
        userStore,
        // biome-ignore lint/style/noNonNullAssertion: clientCache is always set in HTTP mode
        clientCache: clientCache!,
      });

      // 5. Register signal handlers — armed after transport is ready.
      const shutdown = async () => {
        clientCache?.stopSweep();
        await close();
        logger.shutdown();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    } else {
      // stdio mode — no OAuth components instantiated.
      serverResult = await Promise.race([
        createOdooMcpServer({
          odooConfig: config.odoo,
          logFile: config.logFile,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('startup_timeout')), STARTUP_TIMEOUT_MS),
        ),
      ]);

      const { server, logger } = serverResult;

      // 3. Log startup info before connecting (AC-3 — startup BEFORE connect).
      logger.startup({
        odoo_url: config.odoo.url,
        odoo_db: config.odoo.db,
        odoo_username: config.odoo.username,
        mode: config.mode,
      });

      const transport = new StdioServerTransport();
      await server.connect(transport);
      const closeTransport = async () => {
        await transport.close();
      };

      // 5. Register signal handlers — armed after transport is ready.
      const shutdown = async () => {
        await closeTransport();
        logger.shutdown();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
    process.stderr.write(
      `${JSON.stringify({ event: 'startup_error', error_type: errorType, message })}\n`,
    );
    process.exit(1);
  }
})();
