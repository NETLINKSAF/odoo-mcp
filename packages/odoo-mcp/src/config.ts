// @ts-ignore — node:fs has no types without @types/node (matches logger.ts pattern)
import { closeSync, openSync } from 'node:fs';
import { z } from 'zod';
// AppConfig defined in types.ts (T-01 — must land first or be stubbed)
import type { AppConfig } from './types.js';

// Minimal ambient declaration — avoids @types/node dependency.
declare const process: {
  env: Record<string, string | undefined>;
  stderr: { write: (data: string) => boolean };
  exit: (code?: number) => never;
};

const configSchema = z.object({
  ODOO_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/$/, '')),
  ODOO_DB: z.string().min(1),
  ODOO_USERNAME: z.string().min(1),
  ODOO_API_KEY: z.string().min(1),
  ODOO_MCP_LOG_FILE: z.string().optional(),
  MODE: z.enum(['stdio', 'http']).default('stdio'),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_BEARER_TOKEN: z.string().optional(),
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

  if (
    parsed.MODE === 'http' &&
    (parsed.MCP_BEARER_TOKEN === undefined || parsed.MCP_BEARER_TOKEN === '')
  ) {
    process.stderr.write(
      `${JSON.stringify({ event: 'config_error', missing: ['MCP_BEARER_TOKEN'] })}\n`,
    );
    process.exit(1);
  }

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
    mode: parsed.MODE,
    http:
      parsed.MODE === 'http'
        ? {
            port: parsed.MCP_PORT,
            // biome-ignore lint/style/noNonNullAssertion: validated by the conditional exit guard above (MODE=http + empty token → process.exit(1))
            bearerToken: parsed.MCP_BEARER_TOKEN!,
          }
        : undefined,
  };
}
