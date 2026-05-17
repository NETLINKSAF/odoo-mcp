// @ts-ignore — node:crypto available at runtime
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Minimal ambient declarations — avoids @types/node dependency.
// Buffer is a Node.js global; declare only the subset we use here.
declare const Buffer: {
  from(value: string, encoding: string): Buffer;
  concat(arrays: Buffer[]): Buffer;
  alloc(size: number): Buffer;
};

// Opaque type alias so the ambient Buffer above satisfies both overloads.
// At runtime these are real Node.js Buffers.
type Buffer = {
  length: number;
  slice(start: number, end?: number): Buffer;
  toString(encoding?: string): string;
  [index: number]: number;
};

// AES-256-GCM parameters
const IV_LENGTH = 12; // bytes — recommended for GCM
const AUTH_TAG_LENGTH = 16; // bytes — GCM auth tag (128 bits)

export interface EncryptionService {
  /** Returns base64(iv[12] || ciphertext || authTag[16]) */
  encrypt(plaintext: string): string;
  /** Returns plaintext; throws if authTag invalid or blob is malformed */
  decrypt(blob: string): string;
}

/**
 * Creates an AES-256-GCM encryption service bound to the given 32-byte key.
 * A fresh random IV is generated for every encrypt() call — never reused.
 */
export function createEncryptionService(key: Buffer): EncryptionService {
  return {
    encrypt(plaintext: string): string {
      // Fresh 12-byte IV per call — uniqueness is the security invariant.
      // @ts-ignore — randomBytes returns a Buffer at runtime
      const iv: Buffer = randomBytes(IV_LENGTH);
      // @ts-ignore — createCipheriv types not available without @types/node
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      // @ts-ignore — cipher.update returns Buffer
      const ciphertext: Buffer = cipher.update(plaintext, 'utf8');
      // @ts-ignore — cipher.final returns Buffer (empty for GCM, but we must call it)
      cipher.final();
      // @ts-ignore — cipher.getAuthTag returns Buffer
      const authTag: Buffer = cipher.getAuthTag();
      // Concatenate iv || ciphertext || authTag and base64-encode.
      // @ts-ignore — Buffer.concat is a Node.js global
      const combined: Buffer = Buffer.concat([iv, ciphertext, authTag]);
      return combined.toString('base64');
    },

    decrypt(blob: string): string {
      // @ts-ignore — Buffer.from is a Node.js global
      const combined: Buffer = Buffer.from(blob, 'base64');
      const minLen = IV_LENGTH + AUTH_TAG_LENGTH;
      if (combined.length < minLen) {
        throw new Error('Encrypted blob is too short to be valid');
      }
      const iv = combined.slice(0, IV_LENGTH);
      const authTag = combined.slice(combined.length - AUTH_TAG_LENGTH);
      const ciphertext = combined.slice(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);
      // @ts-ignore — createDecipheriv types not available without @types/node
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      // @ts-ignore — setAuthTag is a GCM-specific method
      decipher.setAuthTag(authTag);
      // @ts-ignore — decipher.update returns Buffer
      const plainBuf: Buffer = decipher.update(ciphertext);
      // DO NOT CATCH — decipher.final() throws if the auth tag is invalid,
      // which is the tamper-detection mechanism.
      // @ts-ignore — decipher.final returns Buffer
      const finalBuf: Buffer = decipher.final();
      // @ts-ignore — Buffer.concat is a Node.js global
      return Buffer.concat([plainBuf, finalBuf]).toString('utf8');
    },
  };
}

/**
 * Decodes a base64 string and verifies it represents exactly 32 raw bytes
 * (a valid AES-256 key). Throws a descriptive error on any violation.
 */
export function validateEncryptionKey(base64Key: string): Buffer {
  let key: Buffer;
  try {
    // @ts-ignore — Buffer.from is a Node.js global
    key = Buffer.from(base64Key, 'base64');
  } catch {
    throw new Error(
      "MCP_ENCRYPTION_KEY is not valid base64; generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  if (key.length !== 32) {
    throw new Error(
      `MCP_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256); got ${key.length} bytes. Generate a valid key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}
