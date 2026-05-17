import type { OdooConfig } from '@netlinksinc/odoo-client';

// Buffer is a Node.js global; declare only the subset we use.
declare const Buffer: {
  from(value: string, encoding?: string): { length: number };
  byteLength(str: string): number;
};

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
    /**
     * When `true`, the /health redaction decision trusts the first entry of
     * `X-Forwarded-For` to determine the real client IP. Required for
     * proxy-fronted deployments (Caddy, nginx, fly.io) where every request
     * arrives at Node from the loopback interface. Default `false`.
     */
    trustProxy: boolean;
    /** Public base URL of this MCP server (used in OAuth metadata discovery). */
    publicUrl: string;
    /** 32-byte AES-256-GCM key decoded from MCP_ENCRYPTION_KEY (base64). */
    encryptionKey: ReturnType<typeof Buffer.from>;
    /** Password required for the /admin endpoints. */
    adminPassword: string;
    /** Filesystem path to the JSON user-store file. */
    userStorePath: string;
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

/** Per-request context stored in AsyncLocalStorage. */
export interface RequestContext {
  /** Client IP address extracted from socket or X-Forwarded-For. */
  client_ip: string;
  /** User-Agent header value. */
  user_agent: string;
  /** UUIDv4 unique identifier for this request. */
  request_id: string;
  /** Email of the authenticated OAuth user, if present. */
  user_id?: string;
  /** Email key into UserStore for looking up Odoo credentials, if present. */
  odoo_credentials_handle?: string;
}

/** Resolver: returns per-user OdooClient + session for the current request. */
export type ClientResolver = () => Promise<{
  client: import('@netlinksinc/odoo-client').OdooClient;
  session: import('@netlinksinc/odoo-client').OdooSession;
}>;
