#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { startHttpTransport } from './http-transport.js';
import { createOdooMcpServer } from './server.js';
import type { HealthPayload } from './types.js';

// Minimal ambient declaration — avoids @types/node dependency.
// Includes process.on so SIGTERM/SIGINT handlers can be registered.
declare const process: {
  env: Record<string, string | undefined>;
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
  on: (event: string, handler: () => Promise<void>) => void;
};

(async () => {
  try {
    // 1. Load and validate configuration (exits 1 itself on invalid env).
    const config = loadConfig();

    // 2. Wire all subsystems together.
    const { server, logger, probeOk } = await createOdooMcpServer({
      odooConfig: config.odoo,
      logFile: config.logFile,
    });

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
      const { close } = await startHttpTransport({
        // biome-ignore lint/style/noNonNullAssertion: config.http guaranteed defined when mode='http' (validated in loadConfig)
        port: config.http!.port,
        // biome-ignore lint/style/noNonNullAssertion: config.http guaranteed defined when mode='http' (validated in loadConfig)
        bearerToken: config.http!.bearerToken,
        server,
        logger,
        healthPayload,
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
