#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAdminEndpoints } from './admin.js';
import { createClientCache } from './client-cache.js';
import { loadConfig } from './config.js';
import { createEncryptionService } from './encryption.js';
import { startHttpTransport } from './http-transport.js';
import { createOAuthEndpoints } from './oauth.js';
import { createOdooMcpServer } from './server.js';
import type { HealthPayload } from './types.js';
import { createUserStore } from './user-store.js';

// Minimal ambient declaration — avoids @types/node dependency.
// Includes process.on so SIGTERM/SIGINT handlers can be registered.
declare const process: {
  env: Record<string, string | undefined>;
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
  on: (event: string, handler: () => Promise<void>) => void;
};

/** NFR-3: If startup does not complete within 30 s, exit with code 1. */
const STARTUP_TIMEOUT_MS = 30_000;

(async () => {
  try {
    // 1. Load and validate configuration (exits 1 itself on invalid env).
    const config = loadConfig();

    // 2. Wire all subsystems together — race against the startup timeout.
    //    If createOdooMcpServer hangs (e.g. Odoo unreachable), the timeout
    //    fires and the process exits with startup_error / code 1 (NFR-3).
    const { server, logger, probeOk, probeClient } = await Promise.race([
      createOdooMcpServer({
        odooConfig: config.odoo,
        logFile: config.logFile,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('startup_timeout')), STARTUP_TIMEOUT_MS),
      ),
    ]);

    // 3. Log startup info before connecting (AC-3 — startup BEFORE connect).
    logger.startup({
      odoo_url: config.odoo.url,
      odoo_db: config.odoo.db,
      odoo_username: config.odoo.username,
      mode: config.mode,
    });

    // 4. Dispatch on mode — connect the appropriate transport.
    let closeTransport: () => Promise<void>;

    if (config.mode === 'stdio') {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      closeTransport = async () => {
        await transport.close();
      };
    } else {
      // config.mode === 'http' — config.http is guaranteed defined (validated by loadConfig)
      const healthPayload: HealthPayload = {
        mode: 'http',
        odoo_url: config.odoo.url,
        odoo_db: config.odoo.db,
        started_at: new Date().toISOString(),
        probe_ok: probeOk,
      };
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
      const clientCache = createClientCache({
        maxSize: 100,
        idleTtlMs: 30 * 60_000,
        sweepIntervalMs: 5 * 60_000,
      });
      clientCache.startSweep();
      const oauthEndpoints = createOAuthEndpoints({
        publicUrl: httpCfg.publicUrl,
        port: httpCfg.port,
        odooDb: config.odoo.db,
        userStore,
        probeClient,
        encryptionService,
      });
      const adminEndpoints = createAdminEndpoints({
        adminPassword: httpCfg.adminPassword,
        userStore,
        clientCache,
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
        clientCache,
      });
      closeTransport = close;
    }

    // 5. Register signal handlers — armed after transport is ready.
    const shutdown = async () => {
      await closeTransport();
      logger.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
    process.stderr.write(
      `${JSON.stringify({ event: 'startup_error', error_type: errorType, message })}\n`,
    );
    process.exit(1);
  }
})();
