import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

// Minimal valid env for reuse across tests
const VALID_ENV = {
  ODOO_URL: 'https://erp.example.com',
  ODOO_DB: 'mydb',
  ODOO_USERNAME: 'admin',
  ODOO_API_KEY: 'test-sentinel-value-do-not-leak',
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

  // --- T-03: MODE / MCP_PORT / MCP_BEARER_TOKEN tests ---

  // MODE unset → defaults to stdio, no http field
  it('defaults mode to stdio and http to undefined when MODE is not set', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.mode).toBe('stdio');
    expect(config.http).toBeUndefined();
  });

  // MODE=http + MCP_BEARER_TOKEN=tok → mode http, http.port 3000, http.bearerToken tok
  it('returns mode=http with default port 3000 when MODE=http and bearer token provided', () => {
    const config = loadConfig({ ...VALID_ENV, MODE: 'http', MCP_BEARER_TOKEN: 'tok' });
    expect(config.mode).toBe('http');
    expect(config.http).toBeDefined();
    expect(config.http!.port).toBe(3000);
    expect(config.http!.bearerToken).toBe('tok');
  });

  // MODE=http + MCP_PORT=8080 → http.port 8080
  it('respects MCP_PORT when MODE=http', () => {
    const config = loadConfig({ ...VALID_ENV, MODE: 'http', MCP_BEARER_TOKEN: 'tok', MCP_PORT: '8080' });
    expect(config.http!.port).toBe(8080);
  });

  // MODE=http + MCP_BEARER_TOKEN missing → exits 1, stderr config_error missing MCP_BEARER_TOKEN
  it('exits 1 with missing MCP_BEARER_TOKEN when MODE=http and token absent', () => {
    expect(() => loadConfig({ ...VALID_ENV, MODE: 'http' })).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.missing).toContain('MCP_BEARER_TOKEN');
  });

  // MODE=http + MCP_BEARER_TOKEN empty string → exits 1
  it('exits 1 with missing MCP_BEARER_TOKEN when MODE=http and token is empty string', () => {
    expect(() => loadConfig({ ...VALID_ENV, MODE: 'http', MCP_BEARER_TOKEN: '' })).toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    const payload = JSON.parse(written);
    expect(payload.event).toBe('config_error');
    expect(payload.missing).toContain('MCP_BEARER_TOKEN');
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

  // Security: sentinel API key NOT leaked when MCP_BEARER_TOKEN missing (MODE=http)
  it('does not leak ODOO_API_KEY value when MODE=http and MCP_BEARER_TOKEN is absent', () => {
    expect(() => loadConfig({ ...VALID_ENV, MODE: 'http' })).toThrow('exit:1');

    const written = (stderrSpy.mock.calls[0]?.[0] as string) ?? '';
    expect(written).not.toContain('test-sentinel-value-do-not-leak');
  });
});
