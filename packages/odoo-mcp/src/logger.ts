// Minimal ambient declaration to avoid @types/node dependency.
// stdout is reserved for MCP stdio transport; all log output goes to stderr only.
declare const process: { stderr: { write: (data: string) => boolean } };

// @ts-ignore — @types/node is not installed; this resolves correctly at Node.js runtime
import { openSync, writeSync } from 'node:fs';

export interface Logger {
  toolCall(entry: {
    tool: string;
    args_sanitized: Record<string, unknown>;
    latency_ms: number;
    status: 'ok' | 'error';
    error?: string;
    client_ip?: string; // HTTP mode only
    user_agent?: string; // HTTP mode only
    request_id?: string; // HTTP mode only (UUIDv4, caller-supplied)
  }): void;
  startup(info: {
    odoo_url: string;
    odoo_db: string;
    odoo_username: string;
    mode?: string; // optional — 'stdio' or 'http'
  }): void;
  shutdown(): void;
}

/**
 * Creates a structured JSON logger that writes to stderr (always) and
 * optionally to a file.
 *
 * File lifecycle: when logFile is supplied the fd is opened once with
 * O_APPEND | O_CREAT and mode 0o600, then kept open for the logger's
 * lifetime. This avoids per-write open/close overhead and lets the OS
 * buffer writes correctly.
 */
export function createLogger(logFile?: string): Logger {
  // Open the log file once; fd is -1 when no file is requested.
  const fd: number = logFile !== undefined ? openSync(logFile, 'a', 0o600) : -1;

  function emit(line: string): void {
    process.stderr.write(`${line}\n`);
    if (fd !== -1) {
      writeSync(fd, `${line}\n`);
    }
  }

  return {
    toolCall(entry) {
      const obj: Record<string, unknown> = {
        ts: new Date().toISOString(),
        event: 'tool_call',
        tool: entry.tool,
        args_sanitized: entry.args_sanitized,
        latency_ms: entry.latency_ms,
        status: entry.status,
      };
      // Omit error key entirely when undefined
      if (entry.error !== undefined) {
        obj.error = entry.error;
      }
      // HTTP observability fields — omit entirely when absent
      if (entry.client_ip !== undefined) {
        obj.client_ip = entry.client_ip;
      }
      if (entry.user_agent !== undefined) {
        obj.user_agent = entry.user_agent;
      }
      if (entry.request_id !== undefined) {
        obj.request_id = entry.request_id;
      }
      emit(JSON.stringify(obj));
    },

    startup(info) {
      // MUST NOT include odoo_api_key or any key matching /api_key/i (US-9 AC-2)
      const obj: Record<string, unknown> = {
        ts: new Date().toISOString(),
        event: 'startup',
        odoo_url: info.odoo_url,
        odoo_db: info.odoo_db,
        odoo_username: info.odoo_username,
      };
      // Omit mode key entirely when absent
      if (info.mode !== undefined) {
        obj.mode = info.mode;
      }
      emit(JSON.stringify(obj));
    },

    shutdown() {
      const obj = {
        ts: new Date().toISOString(),
        event: 'shutdown',
      };
      emit(JSON.stringify(obj));
    },
  };
}
