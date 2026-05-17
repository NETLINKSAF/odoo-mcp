import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { statSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.js';

// Each test gets a unique tmp path to prevent cross-test interference
function tmpLogPath(suffix: string): string {
  return join(tmpdir(), `t10-logger-test-${suffix}-${Date.now()}.log`);
}

describe('createLogger — no file (stderr only)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC-1: no file arg → writes to stderr, filesystem untouched
  it('writes toolCall to stderr only — no file created', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 'odoo.search',
      args_sanitized: { model: 'res.partner' },
      latency_ms: 42,
      status: 'ok',
    });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['event']).toBe('tool_call');
    expect(obj['tool']).toBe('odoo.search');
    expect(obj['status']).toBe('ok');
    expect(obj).toHaveProperty('ts');
  });

  it('toolCall with error field includes error key in JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 'odoo.write',
      args_sanitized: {},
      latency_ms: 5,
      status: 'error',
      error: 'Access denied',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['error']).toBe('Access denied');
  });

  it('toolCall without error field omits error key from JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 'odoo.read',
      args_sanitized: {},
      latency_ms: 10,
      status: 'ok',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj).not.toHaveProperty('error');
  });

  // AC-3: startup MUST NOT contain "api_key" anywhere in the serialized line
  it('startup emits event:startup line that does not contain "api_key"', () => {
    const logger = createLogger();
    logger.startup({
      odoo_url: 'https://demo.odoo.com',
      odoo_db: 'mydb',
      odoo_username: 'admin',
    });

    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = stderrSpy.mock.calls[0][0] as string;
    expect(line).not.toMatch(/api_key/i);
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['event']).toBe('startup');
    expect(obj['odoo_url']).toBe('https://demo.odoo.com');
    expect(obj['odoo_db']).toBe('mydb');
    expect(obj['odoo_username']).toBe('admin');
  });

  // AC-4: shutdown emits event:shutdown
  it('shutdown emits a line containing event: "shutdown"', () => {
    const logger = createLogger();
    logger.shutdown();

    expect(stderrSpy).toHaveBeenCalledOnce();
    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['event']).toBe('shutdown');
  });
});

describe('createLogger — with logFile', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let logPath: string;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logPath = tmpLogPath('with-file');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(logPath)) {
      unlinkSync(logPath);
    }
  });

  // AC-2: file created with 0o600 permissions
  it('creates the log file with 0o600 permissions', () => {
    const logger = createLogger(logPath);
    logger.shutdown();

    const mode = statSync(logPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // AC-2: writes to both stderr and the file
  it('writes to both stderr and file on each log call', () => {
    const logger = createLogger(logPath);
    logger.startup({
      odoo_url: 'https://x.example.com',
      odoo_db: 'testdb',
      odoo_username: 'admin',
    });

    // stderr received the line
    expect(stderrSpy).toHaveBeenCalledOnce();
    const stderrLine = (stderrSpy.mock.calls[0][0] as string).trim();

    // file contains the same line
    const fileContents = readFileSync(logPath, 'utf8').trim();
    expect(fileContents).toBe(stderrLine);

    const obj = JSON.parse(stderrLine) as Record<string, unknown>;
    expect(obj['event']).toBe('startup');
  });

  it('appends multiple calls sequentially to the file', () => {
    const logger = createLogger(logPath);
    logger.startup({ odoo_url: 'https://x', odoo_db: 'db', odoo_username: 'u' });
    logger.shutdown();

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first['event']).toBe('startup');
    expect(second['event']).toBe('shutdown');
  });

  it('startup line written to file does not contain "api_key"', () => {
    const logger = createLogger(logPath);
    logger.startup({ odoo_url: 'https://x', odoo_db: 'db', odoo_username: 'admin' });

    const fileContents = readFileSync(logPath, 'utf8');
    expect(fileContents).not.toMatch(/api_key/i);
  });

  // T-02 AC-3: log file created with 0o600 permissions (explicit coverage)
  it('log file created with 0o600 permissions (T-02 AC-3)', () => {
    const path = tmpLogPath('t02-perms');
    const logger = createLogger(path);
    logger.shutdown();
    try {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });
});

describe('createLogger — HTTP observability fields (T-02)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // T-02 AC-1: client_ip and user_agent present when supplied
  it('toolCall with client_ip and user_agent emits both fields in JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 't',
      args_sanitized: {},
      latency_ms: 5,
      status: 'ok',
      client_ip: '1.2.3.4',
      user_agent: 'TestAgent/1',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['client_ip']).toBe('1.2.3.4');
    expect(obj['user_agent']).toBe('TestAgent/1');
  });

  // T-02 AC-2: client_ip and user_agent absent when not supplied
  it('toolCall without HTTP fields omits client_ip and user_agent from JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 't',
      args_sanitized: {},
      latency_ms: 5,
      status: 'ok',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj).not.toHaveProperty('client_ip');
    expect(obj).not.toHaveProperty('user_agent');
  });

  // T-02: request_id present when supplied
  it('toolCall with request_id emits request_id in JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 't',
      args_sanitized: {},
      latency_ms: 5,
      status: 'ok',
      request_id: 'abc-123',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['request_id']).toBe('abc-123');
  });

  // T-02 AC-4: startup with mode emits mode key
  it('startup with mode: "http" emits mode key in JSON', () => {
    const logger = createLogger();
    logger.startup({
      odoo_url: 'https://demo.odoo.com',
      odoo_db: 'mydb',
      odoo_username: 'admin',
      mode: 'http',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['mode']).toBe('http');
  });

  // T-02 AC-4: startup without mode omits mode key
  it('startup without mode omits mode key from JSON', () => {
    const logger = createLogger();
    logger.startup({
      odoo_url: 'https://demo.odoo.com',
      odoo_db: 'mydb',
      odoo_username: 'admin',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj).not.toHaveProperty('mode');
  });

  // T-02 user_id present: emits user_id in JSON
  it('toolCall with user_id emits user_id in JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 'odoo_search_read',
      args_sanitized: {},
      latency_ms: 5,
      status: 'ok',
      user_id: 'user@example.com',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj['user_id']).toBe('user@example.com');
  });

  // T-02 user_id absent: omits user_id from JSON
  it('toolCall without user_id omits user_id from JSON', () => {
    const logger = createLogger();
    logger.toolCall({
      tool: 'odoo_search_read',
      args_sanitized: {},
      latency_ms: 5,
      status: 'ok',
    });

    const line = stderrSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(obj).not.toHaveProperty('user_id');
  });
});
