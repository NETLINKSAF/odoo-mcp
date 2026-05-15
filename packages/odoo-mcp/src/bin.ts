#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createOdooMcpServer } from './server.js';

// Minimal ambient declaration — avoids @types/node dependency.
// Includes process.on so SIGTERM/SIGINT handlers can be registered.
declare const process: {
  env: Record<string, string | undefined>;
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
  on: (event: string, handler: () => void) => void;
};

(async () => {
  try {
    // 1. Load and validate configuration (exits 1 itself on invalid env).
    const config = loadConfig();

    // 2. Wire all subsystems together.
    const { server, logger } = await createOdooMcpServer({
      odooConfig: config.odoo,
      logFile: config.logFile,
    });

    // 3. Log startup info before connecting (AC-3 — startup BEFORE connect).
    logger.startup({
      odoo_url: config.odoo.url,
      odoo_db: config.odoo.db,
      odoo_username: config.odoo.username,
    });

    // 4. Register signal handlers BEFORE connecting so they are armed in time.
    const shutdown = () => {
      logger.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // 5. Connect the transport — blocks until the transport closes.
    await server.connect(new StdioServerTransport());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
    process.stderr.write(
      `${JSON.stringify({ event: 'startup_error', error_type: errorType, message })}\n`,
    );
    process.exit(1);
  }
})();
