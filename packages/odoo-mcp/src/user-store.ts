// @ts-ignore — @types/node not installed
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// @ts-ignore — @types/node not installed
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

import { createEncryptionService } from './encryption.js';
import type { EncryptionService } from './encryption.js';

// ---------------------------------------------------------------------------
// Ambient declarations — avoids @types/node dependency (codebase pattern).
// ---------------------------------------------------------------------------

declare const Buffer: {
  from(value: string, encoding?: string): Buffer;
  alloc(size: number): Buffer;
};

type Buffer = {
  length: number;
  toString(encoding?: string): string;
  [index: number]: number;
};

declare const process: {
  stderr: { write: (data: string) => boolean };
};

// ---------------------------------------------------------------------------
// On-disk schema types (private — not exported).
// ---------------------------------------------------------------------------

interface UserRecordOnDisk {
  email: string; // cleartext, lowercase
  status: 'allowed' | 'registered';
  registered_at: string | null; // ISO 8601 or null
  encrypted_api_key: string | null; // base64(iv[12] || ciphertext || authTag[16])
  odoo_url: string;
  odoo_db: string;
}

interface TokenRecordOnDisk {
  token_hash: string; // SHA256 hex of the raw access token (raw token never stored)
  email: string;
  issued_at: string; // ISO 8601
}

interface UserStoreFile {
  version: 1;
  users: UserRecordOnDisk[];
  tokens: TokenRecordOnDisk[];
}

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

export interface UserStore {
  allow(email: string): Promise<void>;
  revoke(email: string): Promise<void>;
  isAllowed(email: string): boolean;
  /** Registers the user and returns a 64-char hex access token. */
  register(email: string, apiKey: string): Promise<string>;
  getCredentials(email: string): { username: string; apiKey: string } | null;
  resolveToken(token: string): { email: string } | null;
  revokeTokensForUser(email: string): void;
  listUsers(): Array<{ email: string; status: string; registered_at: string | null }>;
  load(): Promise<void>;
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createUserStore(config: {
  filePath: string;
  encryptionKey: Buffer;
  odooUrl: string;
  odooDb: string;
}): UserStore {
  const encryptionService: EncryptionService = createEncryptionService(
    config.encryptionKey as unknown as Parameters<typeof createEncryptionService>[0],
  );

  // In-memory state.
  const users = new Map<string, UserRecordOnDisk>();
  // Maps token_hash → { email, issued_at }
  const tokens = new Map<string, { email: string; issued_at: string }>();

  // Async queue for serialising flush calls.
  let _queue: Promise<void> = Promise.resolve();

  // ---------------------------------------------------------------------------
  // Internal helpers.
  // ---------------------------------------------------------------------------

  function normalizeEmail(email: string): string {
    return email.toLowerCase();
  }

  /** SHA256 hex digest of a raw token string. */
  function hashToken(token: string): string {
    // @ts-ignore — createHash imported above
    return createHash('sha256').update(token).digest('hex');
  }

  async function doFlush(): Promise<void> {
    try {
      const userRecords: UserRecordOnDisk[] = Array.from(users.values());
      const tokenRecords: TokenRecordOnDisk[] = Array.from(tokens.entries()).map(
        ([token_hash, { email, issued_at }]) => ({ token_hash, email, issued_at }),
      );
      const payload: UserStoreFile = { version: 1, users: userRecords, tokens: tokenRecords };
      const json = JSON.stringify(payload, null, 2);
      const tmpPath = `${config.filePath}.tmp`;
      // @ts-ignore — writeFile / rename / chmod imported above
      await writeFile(tmpPath, json, { encoding: 'utf8' });
      // @ts-ignore — rename imported above
      await rename(tmpPath, config.filePath);
      // @ts-ignore — chmod imported above
      await chmod(config.filePath, 0o600);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${JSON.stringify({ event: 'error', message: `user-store flush failed: ${message}` })}\n`,
      );
      // Do NOT rethrow — caller continues with in-memory state.
    }
  }

  // ---------------------------------------------------------------------------
  // Public methods.
  // ---------------------------------------------------------------------------

  const store: UserStore = {
    async allow(email: string): Promise<void> {
      const key = normalizeEmail(email);
      const existing = users.get(key);
      if (existing) {
        // Only upgrade allowed → allowed or keep registered (do NOT downgrade registered).
        if (existing.status !== 'registered') {
          existing.status = 'allowed';
        }
      } else {
        users.set(key, {
          email: key,
          status: 'allowed',
          registered_at: null,
          encrypted_api_key: null,
          odoo_url: config.odooUrl,
          odoo_db: config.odooDb,
        });
      }
      await store.flush();
    },

    async revoke(email: string): Promise<void> {
      const key = normalizeEmail(email);
      // Remove user record SYNCHRONOUSLY from in-memory state first.
      users.delete(key);
      // Remove all tokens for this user SYNCHRONOUSLY.
      for (const [hash, rec] of tokens.entries()) {
        if (normalizeEmail(rec.email) === key) {
          tokens.delete(hash);
        }
      }
      // Then persist.
      await store.flush();
    },

    isAllowed(email: string): boolean {
      const key = normalizeEmail(email);
      const rec = users.get(key);
      return rec !== undefined && (rec.status === 'allowed' || rec.status === 'registered');
    },

    async register(email: string, apiKey: string): Promise<string> {
      const key = normalizeEmail(email);

      // Encrypt the API key.
      const encrypted_api_key = encryptionService.encrypt(apiKey);
      const registered_at = new Date().toISOString();

      const existing = users.get(key);
      if (existing) {
        existing.status = 'registered';
        existing.registered_at = registered_at;
        existing.encrypted_api_key = encrypted_api_key;
        existing.odoo_url = config.odooUrl;
        existing.odoo_db = config.odooDb;
      } else {
        users.set(key, {
          email: key,
          status: 'registered',
          registered_at,
          encrypted_api_key,
          odoo_url: config.odooUrl,
          odoo_db: config.odooDb,
        });
      }

      // Generate access token: 32 random bytes → 64-char hex.
      // @ts-ignore — randomBytes imported above
      const rawToken: string = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const issued_at = new Date().toISOString();

      // Enforce token cap of 10 per user — evict oldest if already at cap.
      const userTokens = Array.from(tokens.entries())
        .filter(([, rec]) => normalizeEmail(rec.email) === key)
        .sort((a, b) => a[1].issued_at.localeCompare(b[1].issued_at));

      if (userTokens.length >= 10) {
        // Remove the oldest token(s) to stay below cap after inserting the new one.
        const toRemove = userTokens.slice(0, userTokens.length - 9);
        for (const [hash] of toRemove) {
          tokens.delete(hash);
        }
      }

      tokens.set(tokenHash, { email: key, issued_at });

      await store.flush();
      return rawToken;
    },

    getCredentials(email: string): { username: string; apiKey: string } | null {
      const key = normalizeEmail(email);
      const rec = users.get(key);
      if (!rec || rec.status !== 'registered' || rec.encrypted_api_key === null) {
        return null;
      }
      try {
        const apiKey = encryptionService.decrypt(rec.encrypted_api_key);
        return { username: rec.email, apiKey };
      } catch {
        // Decrypt failure — MUST NOT log the apiKey value.
        process.stderr.write(
          `${JSON.stringify({ event: 'error', message: `getCredentials: decrypt failed for ${key}` })}\n`,
        );
        return null;
      }
    },

    resolveToken(token: string): { email: string } | null {
      try {
        const presentedHash = hashToken(token);
        // @ts-ignore — Buffer.from is a Node.js global
        const presentedBuf: Buffer = Buffer.from(presentedHash, 'hex');
        for (const [storedHash, rec] of tokens.entries()) {
          // @ts-ignore — Buffer.from is a Node.js global
          const storedBuf: Buffer = Buffer.from(storedHash, 'hex');
          // @ts-ignore — timingSafeEqual imported above
          if (timingSafeEqual(storedBuf, presentedBuf)) {
            return { email: rec.email };
          }
        }
        return null;
      } catch {
        return null;
      }
    },

    revokeTokensForUser(email: string): void {
      const key = normalizeEmail(email);
      for (const [hash, rec] of tokens.entries()) {
        if (normalizeEmail(rec.email) === key) {
          tokens.delete(hash);
        }
      }
      // Does NOT call flush — caller composes with flush if needed.
    },

    listUsers(): Array<{ email: string; status: string; registered_at: string | null }> {
      return Array.from(users.values()).map(({ email, status, registered_at }) => ({
        email,
        status,
        registered_at,
      }));
    },

    async load(): Promise<void> {
      let raw: string;
      try {
        // @ts-ignore — readFile imported above
        raw = await readFile(config.filePath, { encoding: 'utf8' });
      } catch (err: unknown) {
        // File not found → start fresh (log warning, do not throw).
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') {
          process.stderr.write(
            `${JSON.stringify({ event: 'warning', message: 'user store not found, starting fresh' })}\n`,
          );
        } else {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `${JSON.stringify({ event: 'error', message: `user-store load failed: ${message}` })}\n`,
          );
        }
        return;
      }

      let parsed: UserStoreFile;
      try {
        parsed = JSON.parse(raw) as UserStoreFile;
      } catch {
        process.stderr.write(
          `${JSON.stringify({ event: 'error', message: 'user-store file is not valid JSON, starting fresh' })}\n`,
        );
        return;
      }

      // Clear existing in-memory state before loading.
      users.clear();
      tokens.clear();

      // Load users — skip records with decryption failures.
      for (const rec of parsed.users ?? []) {
        if (rec.status === 'registered' && rec.encrypted_api_key !== null) {
          try {
            encryptionService.decrypt(rec.encrypted_api_key);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `${JSON.stringify({
                event: 'error',
                message: `user-store: skipping corrupt record for ${rec.email}: ${message}`,
              })}\n`,
            );
            continue; // Skip this record — US-5 AC-7.
          }
        }
        users.set(normalizeEmail(rec.email), rec);
      }

      // Load tokens.
      for (const tok of parsed.tokens ?? []) {
        tokens.set(tok.token_hash, { email: tok.email, issued_at: tok.issued_at });
      }
    },

    flush(): Promise<void> {
      _queue = _queue.then(() => doFlush());
      return _queue;
    },
  };

  return store;
}
