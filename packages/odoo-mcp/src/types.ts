import type { OdooConfig } from '@netlinksinc/odoo-client';

/**
 * Full application configuration — merges Odoo connection settings with
 * MCP transport options.  Loaded once at startup by `config.ts`.
 */
export interface AppConfig {
  /** Odoo connection credentials and URL. */
  odoo: OdooConfig;
  /** Optional path to a file for structured JSON log output. */
  logFile?: string;
  /** Transport mode: `stdio` for local MCP use, `http` for remote HTTP+SSE. */
  mode: 'stdio' | 'http';
  /**
   * HTTP transport settings.  Required when `mode === 'http'`; callers that
   * depend on `mode === 'http'` must use a non-null assertion (`config.http!`)
   * or narrow the discriminant before accessing these fields.
   */
  http?: {
    /** TCP port the HTTP server will listen on. */
    port: number;
    /** Bearer token that clients must supply in the `Authorization` header. */
    bearerToken: string;
    /**
     * When `true`, the /health redaction decision trusts the first entry of
     * `X-Forwarded-For` to determine the real client IP. Required for
     * proxy-fronted deployments (Caddy, nginx, fly.io) where every request
     * arrives at Node from the loopback interface. Default `false`.
     */
    trustProxy: boolean;
  };
}

/**
 * Body returned by `GET /health` when the server is running in HTTP mode.
 * All fields are always present in the response.
 */
export interface HealthPayload {
  /** Discriminant — always `'http'` on this endpoint. */
  mode: 'http';
  /** Odoo instance base URL (no trailing slash). */
  odoo_url: string;
  /** Odoo database name. */
  odoo_db: string;
  /** ISO 8601 timestamp of when the HTTP server started. */
  started_at: string;
  /** Whether the last Odoo connectivity probe succeeded. */
  probe_ok: boolean;
}

/**
 * Full health-check response — adds a top-level `ok` convenience flag to
 * `HealthPayload` so clients can gate on a single boolean without inspecting
 * `probe_ok`.
 */
export interface HealthResponse {
  /** `true` when `probe_ok` is `true` and the server is fully operational. */
  ok: boolean;
  /** Discriminant — always `'http'` on this endpoint. */
  mode: 'http';
  /** Odoo instance base URL (no trailing slash). */
  odoo_url: string;
  /** Odoo database name. */
  odoo_db: string;
  /** ISO 8601 timestamp of when the HTTP server started. */
  started_at: string;
  /** Whether the last Odoo connectivity probe succeeded. */
  probe_ok: boolean;
}
