// @ts-ignore — node:fs has no types without @types/node (matches logger.ts pattern)
import { closeSync, openSync } from 'node:fs';
import type { OdooConfig } from '@netlinksinc/odoo-client';
import { z } from 'zod';

// Minimal ambient declaration — avoids @types/node dependency.
declare const process: {
  env: Record<string, string | undefined>;
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
};

export interface AppConfig {
  odoo: OdooConfig;
  logFile?: string;
}

const configSchema = z.object({
  ODOO_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/$/, '')),
  ODOO_DB: z.string().min(1),
  ODOO_USERNAME: z.string().min(1),
  ODOO_API_KEY: z.string().min(1),
  ODOO_MCP_LOG_FILE: z.string().optional(),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const missing: string[] = [];
    const invalid: string[] = [];

    for (const issue of result.error.issues) {
      // path[0] is the env var name
      const name = String(issue.path[0]);
      if (issue.code === 'invalid_type' && issue.received === 'undefined') {
        missing.push(name);
      } else {
        if (!invalid.includes(name)) {
          invalid.push(name);
        }
      }
    }

    // CRITICAL: Do NOT include any values from env — only names (AC-6 / US-1 AC-6)
    process.stderr.write(`${JSON.stringify({ event: 'config_error', missing, invalid })}\n`);
    process.exit(1);
  }

  // TypeScript discriminated union: result.success is true here, so result.data is defined.
  const parsed = result.data;

  if (parsed.ODOO_MCP_LOG_FILE !== undefined) {
    const logFile = parsed.ODOO_MCP_LOG_FILE;
    try {
      const fd = openSync(logFile, 'a');
      closeSync(fd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${JSON.stringify({ event: 'log_file_error', path: logFile, message })}\n`,
      );
      process.exit(1);
    }
  }

  return {
    odoo: {
      url: parsed.ODOO_URL,
      db: parsed.ODOO_DB,
      username: parsed.ODOO_USERNAME,
      apiKey: parsed.ODOO_API_KEY,
    },
    logFile: parsed.ODOO_MCP_LOG_FILE,
  };
}
