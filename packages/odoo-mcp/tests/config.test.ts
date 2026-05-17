import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

// Minimal valid env for reuse across tests
const VALID_ENV = {
  ODOO_URL: 'https://erp.example.com',
  ODOO_DB: 'mydb',
  ODOO_USERNAME: 'admin',
  ODOO_API_KEY: 'test-sentinel-value-do-not-leak',
};

// 32-byte key encoded as base64 (openssl rand -base64 32 equivalent)
const VALID_32_BYTE_KEY = Buffer.from(new Uint8Array(32).fill(0xab)).toString('base64');
// 16-byte key (wrong length)
const WRONG_LENGTH_KEY = Buffer.from(new Uint8Array(16).fill(0xcd)).toString('base64');

// Minimal valid env for MODE=http
const VALID_HTTP_ENV = {
  ...VALID_ENV,
  MODE: 'http' as const,
  MCP_ENCRYPTION_KEY: VALID_32_BYTE_KEY,
  MCP_ADMIN_PASSWORD: 'super-secret-admin',
};

describe('loadConfig', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code) => {
        throw new Error(`exit:${code}`);
      }) as never);

    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC-1: all 4 required vars present → returns AppConfig with no trailing slash
  it('returns AppConfig with odoo.url having no trailing slash', () => {
    const config = loadConfig({ ...VALID_ENV, ODOO_URL: 'https://erp.example.com/' });
    expect(config.odoo.url).toBe('https://erp.example.com');
    expect(config.odoo.db).toBe('mydb');
    expect(config.odoo.username).toBe('admin');
    expect(config.odoo.apiKey).toBe('test-sentinel-value-do-not-leak');
    expect(config.logFile).toBeUndefined();
  });

  // AC-1: URL without trailing slash is returned unchanged
  it('returns AppConfig unchanged when URL has no trailing slash', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.odoo.url).toBe('https://erp.example.com');
  });

  // AC-2: ODOO_URL missing → process.exit(1) and stderr has ODOO_URL in missing
  it('calls process.exit(1) when ODOO_URL is missing', () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).ODOO_URL;

    expect(() => loadConfig(env as Record<string, string | undefined>)).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.missing).toContain('ODOO_URL');
  });

  // AC-2 (security): stderr output MUST NOT contain the API key value
  it('does not leak ODOO_API_KEY value in config_error output', () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string | undefined>).ODOO_URL;

    expect(() => loadConfig(env as Record<string, string | undefined>)).toThrow('exit:1');

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    expect(written).not.toContain('test-sentinel-value-do-not-leak');
  });

  // AC-3: ODOO_URL is "not-a-url" → process.exit(1) and stderr identifies ODOO_URL as invalid
  it('calls process.exit(1) and marks ODOO_URL invalid when URL is malformed', () => {
    const env = { ...VALID_ENV, ODOO_URL: 'not-a-url' };

    expect(() => loadConfig(env)).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.invalid).toContain('ODOO_URL');
  });

  // Multiple missing fields → all are collected
  it('collects all missing required env vars in a single error', () => {
    expect(() => loadConfig({})).toThrow('exit:1');

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.missing).toContain('ODOO_URL');
    expect(payload.missing).toContain('ODOO_DB');
    expect(payload.missing).toContain('ODOO_USERNAME');
    expect(payload.missing).toContain('ODOO_API_KEY');
  });

  // ODOO_MCP_LOG_FILE optional → returned in AppConfig when set
  it('returns logFile when ODOO_MCP_LOG_FILE is set and path is writable', () => {
    const config = loadConfig({ ...VALID_ENV, ODOO_MCP_LOG_FILE: '/tmp/odoo-mcp-test-config.log' });
    expect(config.logFile).toBe('/tmp/odoo-mcp-test-config.log');
  });

  // AC-4: unwritable ODOO_MCP_LOG_FILE path → process.exit(1)
  it('calls process.exit(1) when ODOO_MCP_LOG_FILE path is not writable', () => {
    const badPath = `/nonexistent-dir-${Date.now()}/log.txt`;
    const env = { ...VALID_ENV, ODOO_MCP_LOG_FILE: badPath };

    expect(() => loadConfig(env)).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('log_file_error');
    expect(payload.path).toBe(badPath);
    expect(typeof payload.message).toBe('string');
  });

  // Stderr output for config_error is valid JSON
  it('writes valid JSON to stderr on config_error', () => {
    expect(() => loadConfig({})).toThrow('exit:1');

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    // Should not throw
    expect(() => JSON.parse(written)).not.toThrow();
  });

  // --- MODE / MCP_PORT tests ---

  // MODE unset → defaults to stdio, no http field
  it('defaults mode to stdio and http to undefined when MODE is not set', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.mode).toBe('stdio');
    expect(config.http).toBeUndefined();
  });

  // MODE=http + MCP_PORT=8080 → http.port 8080
  it('respects MCP_PORT when MODE=http', () => {
    const config = loadConfig({ ...VALID_HTTP_ENV, MCP_PORT: '8080' });
    expect(config.http!.port).toBe(8080);
  });

  // MODE=invalid → exits 1, stderr config_error with invalid: ['MODE']
  it('exits 1 with invalid MODE when an unsupported value is provided', () => {
    expect(() => loadConfig({ ...VALID_ENV, MODE: 'invalid' })).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.invalid).toContain('MODE');
  });

  // MODE=stdio + MCP_BEARER_TOKEN missing → no exit (backwards compatible, US-2 AC-5)
  it('succeeds without exit when MODE=stdio and MCP_BEARER_TOKEN is absent', () => {
    const config = loadConfig(VALID_ENV);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.mode).toBe('stdio');
  });

  // --- T-01: OAuth / MCP_BEARER_TOKEN deprecation + new HTTP fields ---

  // AC-1: MCP_BEARER_TOKEN set with MODE=http → deprecation_warning emitted, no exit
  it('emits deprecation_warning to stderr but does NOT exit when MCP_BEARER_TOKEN is set with MODE=http', () => {
    const config = loadConfig({ ...VALID_HTTP_ENV, MCP_BEARER_TOKEN: 'old-token' });
    expect(exitSpy).not.toHaveBeenCalled();

    const allWrites = stderrSpy.mock.calls.map((c) => c[0] as string);
    const deprecationLine = allWrites.find((line) => {
      try {
        return JSON.parse(line).event === 'deprecation_warning';
      } catch {
        return false;
      }
    });
    expect(deprecationLine).toBeDefined();
    const payload = JSON.parse(deprecationLine!);
    expect(payload.event).toBe('deprecation_warning');
    expect(payload.message).toContain('MCP_BEARER_TOKEN');
    // config is still returned
    expect(config.mode).toBe('http');
  });

  // AC-2: MODE=http without MCP_ENCRYPTION_KEY → config_error + exit(1)
  it('exits 1 with config_error missing MCP_ENCRYPTION_KEY when MODE=http and key is absent', () => {
    const env = { ...VALID_HTTP_ENV } as Record<string, string | undefined>;
    delete env.MCP_ENCRYPTION_KEY;

    expect(() => loadConfig(env)).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.missing).toContain('MCP_ENCRYPTION_KEY');
  });

  // AC-3: MODE=http with MCP_ENCRYPTION_KEY of wrong length (16 bytes) → config_error + exit(1)
  it('exits 1 with config_error when MCP_ENCRYPTION_KEY decodes to wrong byte length', () => {
    expect(() =>
      loadConfig({ ...VALID_HTTP_ENV, MCP_ENCRYPTION_KEY: WRONG_LENGTH_KEY }),
    ).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.missing).toContain('MCP_ENCRYPTION_KEY');
  });

  // AC-4: MODE=http without MCP_ADMIN_PASSWORD → config_error + exit(1)
  it('exits 1 with config_error missing MCP_ADMIN_PASSWORD when MODE=http and password is absent', () => {
    const env = { ...VALID_HTTP_ENV } as Record<string, string | undefined>;
    delete env.MCP_ADMIN_PASSWORD;

    expect(() => loadConfig(env)).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const allWrites = stderrSpy.mock.calls.map((c) => c[0] as string);
    const errorLine = allWrites.find((line) => {
      try {
        return JSON.parse(line).event === 'config_error';
      } catch {
        return false;
      }
    });
    expect(errorLine).toBeDefined();
    const payload = JSON.parse(errorLine!);
    expect(payload.missing).toContain('MCP_ADMIN_PASSWORD');
  });

  // AC-5: MODE=http with all required env → http has 6 fields, encryptionKey is 32-byte Buffer, no bearerToken
  it('returns AppConfig with 6-field http object including 32-byte encryptionKey when all env is valid', () => {
    const config = loadConfig(VALID_HTTP_ENV);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(config.mode).toBe('http');
    expect(config.http).toBeDefined();

    const http = config.http!;

    // Must have exactly 6 keys
    expect(Object.keys(http)).toHaveLength(6);
    expect(Object.keys(http)).toContain('port');
    expect(Object.keys(http)).toContain('trustProxy');
    expect(Object.keys(http)).toContain('publicUrl');
    expect(Object.keys(http)).toContain('encryptionKey');
    expect(Object.keys(http)).toContain('adminPassword');
    expect(Object.keys(http)).toContain('userStorePath');

    // bearerToken must NOT exist
    expect('bearerToken' in http).toBe(false);

    // encryptionKey must be a 32-byte Buffer
    expect(http.encryptionKey).toBeDefined();
    expect(http.encryptionKey.length).toBe(32);

    // Other field values
    expect(http.port).toBe(3000);
    expect(http.trustProxy).toBe(false);
    expect(http.publicUrl).toBe('');
    expect(http.adminPassword).toBe('super-secret-admin');
    expect(http.userStorePath).toBe('/var/lib/odoo-mcp/users.json');
  });

  // publicUrl respected when MCP_PUBLIC_URL is set
  it('sets publicUrl from MCP_PUBLIC_URL when provided', () => {
    const config = loadConfig({ ...VALID_HTTP_ENV, MCP_PUBLIC_URL: 'https://mcp.example.com' });
    expect(config.http!.publicUrl).toBe('https://mcp.example.com');
  });

  // userStorePath respected when MCP_USER_STORE_PATH is set
  it('sets userStorePath from MCP_USER_STORE_PATH when provided', () => {
    const config = loadConfig({ ...VALID_HTTP_ENV, MCP_USER_STORE_PATH: '/tmp/users.json' });
    expect(config.http!.userStorePath).toBe('/tmp/users.json');
  });

  // Security: sentinel API key NOT leaked when MCP_ENCRYPTION_KEY missing (MODE=http)
  it('does not leak ODOO_API_KEY value when MODE=http and MCP_ENCRYPTION_KEY is absent', () => {
    const env = { ...VALID_HTTP_ENV } as Record<string, string | undefined>;
    delete env.MCP_ENCRYPTION_KEY;

    expect(() => loadConfig(env)).toThrow('exit:1');

    const allWrites = stderrSpy.mock.calls.map((c) => c[0] as string);
    for (const line of allWrites) {
      expect(line).not.toContain('test-sentinel-value-do-not-leak');
    }
  });
});
