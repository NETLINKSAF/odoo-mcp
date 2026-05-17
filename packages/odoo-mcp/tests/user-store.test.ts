import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserStore } from '../src/user-store.js';
import type { UserStore } from '../src/user-store.js';

// T-04: user-store tests
// Use a stable 32-byte key for all test suites.
const TEST_KEY = randomBytes(32) as unknown as Buffer;

/** Create a fresh store backed by a temp file in a throwaway directory. */
async function makeTmpStore(): Promise<{ store: UserStore; dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 't04-user-store-'));
  const filePath = join(dir, 'users.json');
  const store = createUserStore({
    filePath,
    encryptionKey: TEST_KEY,
    odooUrl: 'https://odoo.example.com',
    odooDb: 'testdb',
  });
  return { store, dir, filePath };
}

/** Convenience: create an in-memory store (no real load/flush needed for most unit tests). */
function makeMemStore(): UserStore {
  // Use a path that definitely does not exist for the initial state.
  return createUserStore({
    filePath: `/tmp/t04-nonexistent-${randomBytes(8).toString('hex')}.json`,
    encryptionKey: TEST_KEY,
    odooUrl: 'https://odoo.example.com',
    odooDb: 'testdb',
  });
}

// ---------------------------------------------------------------------------
// allow + isAllowed round-trip (case-insensitive).
// ---------------------------------------------------------------------------
describe('allow + isAllowed', () => {
  let store: UserStore;

  beforeEach(() => {
    store = makeMemStore();
  });

  it('allow then isAllowed returns true (same case)', async () => {
    await store.allow('user@example.com');
    expect(store.isAllowed('user@example.com')).toBe(true);
  });

  it('allow upper-case, isAllowed lower-case returns true (case-insensitive)', async () => {
    await store.allow('A@x.com');
    expect(store.isAllowed('a@x.com')).toBe(true);
  });

  it('unknown email → isAllowed returns false', () => {
    expect(store.isAllowed('nobody@example.com')).toBe(false);
  });

  it('isAllowed returns true for registered users too', async () => {
    await store.allow('reg@example.com');
    await store.register('reg@example.com', 'api-key-123');
    expect(store.isAllowed('reg@example.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// register + resolveToken.
// ---------------------------------------------------------------------------
describe('register + resolveToken', () => {
  let store: UserStore;

  beforeEach(() => {
    store = makeMemStore();
  });

  it('register returns a 64-char hex token', async () => {
    await store.allow('alice@example.com');
    const token = await store.register('alice@example.com', 'my-api-key');
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  it('resolveToken returns { email } for a valid token', async () => {
    await store.allow('alice@example.com');
    const token = await store.register('alice@example.com', 'my-api-key');
    const result = store.resolveToken(token);
    expect(result).toEqual({ email: 'alice@example.com' });
  });

  it('resolveToken returns null for an unknown token', () => {
    const fakeToken = randomBytes(32).toString('hex');
    expect(store.resolveToken(fakeToken)).toBeNull();
  });

  it('two consecutive registers yield different tokens', async () => {
    await store.allow('alice@example.com');
    const t1 = await store.register('alice@example.com', 'key-1');
    const t2 = await store.register('alice@example.com', 'key-2');
    expect(t1).not.toBe(t2);
  });
});

// ---------------------------------------------------------------------------
// revoke.
// ---------------------------------------------------------------------------
describe('revoke', () => {
  let store: UserStore;

  beforeEach(() => {
    store = makeMemStore();
  });

  it('revoke removes user from isAllowed immediately (before flush completes)', async () => {
    await store.allow('bob@example.com');
    // Kick off revoke — do NOT await yet.
    const revokePromise = store.revoke('bob@example.com');
    // The in-memory state must already reflect the revocation.
    expect(store.isAllowed('bob@example.com')).toBe(false);
    await revokePromise;
  });

  it('revoke removes user from listUsers', async () => {
    await store.allow('bob@example.com');
    await store.revoke('bob@example.com');
    const list = store.listUsers();
    expect(list.find((u) => u.email === 'bob@example.com')).toBeUndefined();
  });

  it('revoke removes all user tokens — resolveToken returns null immediately', async () => {
    await store.allow('bob@example.com');
    const token = await store.register('bob@example.com', 'key');
    // Kick off revoke — do NOT await.
    const revokePromise = store.revoke('bob@example.com');
    // Concurrent resolve must not see the revoked token.
    expect(store.resolveToken(token)).toBeNull();
    await revokePromise;
    expect(store.resolveToken(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token cap (10 per user).
// ---------------------------------------------------------------------------
describe('token cap', () => {
  it('calling register 11 times for the same user results in exactly 10 tokens', async () => {
    const store = makeMemStore();
    await store.allow('carol@example.com');

    const tokens: string[] = [];
    for (let i = 0; i < 11; i++) {
      tokens.push(await store.register('carol@example.com', `key-${i}`));
    }

    // The first (oldest) token must have been evicted.
    expect(store.resolveToken(tokens[0]!)).toBeNull();

    // The most recent 10 tokens must still resolve.
    let validCount = 0;
    for (let i = 1; i <= 10; i++) {
      if (store.resolveToken(tokens[i]!) !== null) {
        validCount++;
      }
    }
    expect(validCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// load — missing file.
// ---------------------------------------------------------------------------
describe('load with missing file', () => {
  it('starts empty and does not throw when file does not exist', async () => {
    const store = createUserStore({
      filePath: `/tmp/t04-no-such-file-${randomBytes(8).toString('hex')}.json`,
      encryptionKey: TEST_KEY,
      odooUrl: 'https://odoo.example.com',
      odooDb: 'testdb',
    });
    await expect(store.load()).resolves.not.toThrow();
    expect(store.listUsers()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// load — corrupt encrypted_api_key skips record, loads others.
// ---------------------------------------------------------------------------
describe('load with corrupt encrypted_api_key', () => {
  it('skips corrupt record and loads valid ones', async () => {
    const { store, dir, filePath } = await makeTmpStore();

    // Build a store file with one good and one corrupt record.
    // We first register normally to get a properly encrypted key for the good record.
    await store.allow('good@example.com');
    await store.register('good@example.com', 'valid-key');
    await store.allow('corrupt@example.com');
    // Manually patch the file with a corrupt encrypted_api_key for 'corrupt@example.com'.
    await store.flush();

    const raw = await import('node:fs/promises').then((m) => m.readFile(filePath, 'utf8'));
    const data = JSON.parse(raw);
    for (const user of data.users) {
      if (user.email === 'corrupt@example.com') {
        // Force status to 'registered' and set garbage key.
        user.status = 'registered';
        user.encrypted_api_key = 'not-valid-base64-encrypted-blob';
        user.registered_at = new Date().toISOString();
      }
    }
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

    // Load fresh store from the patched file.
    const store2 = createUserStore({
      filePath,
      encryptionKey: TEST_KEY,
      odooUrl: 'https://odoo.example.com',
      odooDb: 'testdb',
    });
    await store2.load();

    const users = store2.listUsers();
    expect(users.find((u) => u.email === 'good@example.com')).toBeDefined();
    expect(users.find((u) => u.email === 'corrupt@example.com')).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// flush — atomic write + chmod + .tmp cleanup.
// ---------------------------------------------------------------------------
describe('flush', () => {
  it('writes a .tmp file then renames it (no .tmp remains after flush)', async () => {
    const { store, dir, filePath } = await makeTmpStore();
    await store.allow('dave@example.com');
    await store.flush();

    // The final file must exist.
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();

    // The .tmp file must NOT exist after the atomic rename.
    const { access } = await import('node:fs/promises');
    await expect(access(filePath + '.tmp')).rejects.toThrow();

    await rm(dir, { recursive: true, force: true });
  });

  it('written file does not contain raw token values — only token_hash', async () => {
    const { store, dir, filePath } = await makeTmpStore();
    await store.allow('dave@example.com');
    const token = await store.register('dave@example.com', 'some-key');
    await store.flush();

    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf8');
    // The raw token must NOT appear in the file.
    expect(content).not.toContain(token);
    // The file must have a token_hash field.
    const data = JSON.parse(content);
    expect(data.tokens.length).toBeGreaterThan(0);
    expect(data.tokens[0].token_hash).toBeDefined();

    await rm(dir, { recursive: true, force: true });
  });

  it('flush on disk error logs to stderr but does not throw and in-memory state intact', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const store = createUserStore({
        // Use a path inside a non-existent directory to force a write error.
        filePath: `/tmp/t04-no-such-dir-${randomBytes(8).toString('hex')}/users.json`,
        encryptionKey: TEST_KEY,
        odooUrl: 'https://odoo.example.com',
        odooDb: 'testdb',
      });
      await store.allow('eve@example.com');

      // flush() must not throw.
      await expect(store.flush()).resolves.not.toThrow();

      // In-memory state must still be intact.
      expect(store.isAllowed('eve@example.com')).toBe(true);

      // stderr must have been written with an error.
      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      const hasFlushError = calls.some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.event === 'error' && typeof obj.message === 'string';
        } catch {
          return false;
        }
      });
      expect(hasFlushError).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// getCredentials.
// ---------------------------------------------------------------------------
describe('getCredentials', () => {
  it('returns { username, apiKey } for a registered user', async () => {
    const store = makeMemStore();
    await store.allow('frank@example.com');
    await store.register('frank@example.com', 'frank-api-key');
    const creds = store.getCredentials('frank@example.com');
    expect(creds).not.toBeNull();
    expect(creds!.username).toBe('frank@example.com');
    expect(creds!.apiKey).toBe('frank-api-key');
  });

  it('returns null for an allowed-only (not registered) user', async () => {
    const store = makeMemStore();
    await store.allow('allowed-only@example.com');
    expect(store.getCredentials('allowed-only@example.com')).toBeNull();
  });

  it('returns null when decrypt fails (corrupt encrypted_api_key)', async () => {
    const { store, dir, filePath } = await makeTmpStore();
    await store.allow('grace@example.com');
    await store.register('grace@example.com', 'grace-key');
    await store.flush();

    // Corrupt the encrypted_api_key in the file and reload.
    const { readFile, writeFile: wf } = await import('node:fs/promises');
    const raw = await readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    for (const user of data.users) {
      if (user.email === 'grace@example.com') {
        user.encrypted_api_key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='; // wrong authTag
      }
    }
    await wf(filePath, JSON.stringify(data, null, 2), 'utf8');

    // Use a different key to guarantee decrypt failure on the tampered blob.
    const wrongKey = randomBytes(32) as unknown as Buffer;
    const store2 = createUserStore({
      filePath,
      encryptionKey: wrongKey,
      odooUrl: 'https://odoo.example.com',
      odooDb: 'testdb',
    });
    await store2.load();

    // getCredentials must return null without throwing.
    expect(store2.getCredentials('grace@example.com')).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// listUsers — must NOT include encrypted_api_key.
// ---------------------------------------------------------------------------
describe('listUsers', () => {
  it('does not include encrypted_api_key in the returned entries', async () => {
    const store = makeMemStore();
    await store.allow('henry@example.com');
    await store.register('henry@example.com', 'henry-key');
    const list = store.listUsers();
    for (const entry of list) {
      expect('encrypted_api_key' in entry).toBe(false);
    }
  });

  it('includes email, status, and registered_at fields', async () => {
    const store = makeMemStore();
    await store.allow('ivan@example.com');
    const list = store.listUsers();
    const ivan = list.find((u) => u.email === 'ivan@example.com');
    expect(ivan).toBeDefined();
    expect(ivan!.status).toBe('allowed');
    expect(ivan!.registered_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeTokensForUser.
// ---------------------------------------------------------------------------
describe('revokeTokensForUser', () => {
  it('removes all tokens for the specified user without calling flush', async () => {
    const store = makeMemStore();
    await store.allow('judy@example.com');
    const token = await store.register('judy@example.com', 'j-key');
    expect(store.resolveToken(token)).not.toBeNull();

    store.revokeTokensForUser('judy@example.com');
    expect(store.resolveToken(token)).toBeNull();
    // User record must still exist (only tokens were revoked).
    expect(store.isAllowed('judy@example.com')).toBe(true);
  });
});
