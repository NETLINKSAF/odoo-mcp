import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createEncryptionService, validateEncryptionKey } from '../src/encryption.js';
import type { EncryptionService } from '../src/encryption.js';

// Each test suite gets a fresh 32-byte key — never share keys across suites.
describe('EncryptionService — round-trip', () => {
	let service: EncryptionService;

	beforeEach(() => {
		const key = randomBytes(32) as unknown as Buffer;
		service = createEncryptionService(key as unknown as Parameters<typeof createEncryptionService>[0]);
	});

	// AC-1: round-trip for a short string
	it('decrypt(encrypt("hi")) === "hi"', () => {
		expect(service.decrypt(service.encrypt('hi'))).toBe('hi');
	});

	// AC-1: round-trip for a long string (~500 chars)
	it('round-trip for a ~500-char string', () => {
		const long = 'a'.repeat(500);
		expect(service.decrypt(service.encrypt(long))).toBe(long);
	});

	// AC-1: round-trip for an empty string
	it('round-trip for empty string', () => {
		expect(service.decrypt(service.encrypt(''))).toBe('');
	});
});

describe('EncryptionService — IV uniqueness', () => {
	// AC-2 (spec): two encrypt() calls on same plaintext + same key yield different blobs
	it('two encryptions of the same plaintext produce different base64 outputs', () => {
		const key = randomBytes(32) as unknown as Buffer;
		const service = createEncryptionService(key as unknown as Parameters<typeof createEncryptionService>[0]);
		const blob1 = service.encrypt('same plaintext');
		const blob2 = service.encrypt('same plaintext');
		expect(blob1).not.toBe(blob2);
	});
});

describe('EncryptionService — tamper detection', () => {
	// AC-2 (acceptance): modify one byte → decrypt() throws
	it('modified blob causes decrypt() to throw', () => {
		const key = randomBytes(32) as unknown as Buffer;
		const service = createEncryptionService(key as unknown as Parameters<typeof createEncryptionService>[0]);
		const blob = service.encrypt('sensitive data');

		// Decode, flip the last byte of the auth tag, re-encode
		const raw = Buffer.from(blob, 'base64');
		// Flip the very last byte (part of the 16-byte auth tag)
		raw[raw.length - 1] ^= 0xff;
		const tampered = raw.toString('base64');

		expect(() => service.decrypt(tampered)).toThrow();
	});
});

describe('validateEncryptionKey', () => {
	// AC-2 (acceptance): 32-byte base64 → returns Buffer of length 32
	it('accepts a valid 32-byte base64 key', () => {
		const key = randomBytes(32);
		const b64 = key.toString('base64');
		const result = validateEncryptionKey(b64);
		expect(result.length).toBe(32);
	});

	// AC-2 (acceptance): 16-byte base64 → throws
	it('throws for a 16-byte (too short) key', () => {
		const b64 = randomBytes(16).toString('base64');
		expect(() => validateEncryptionKey(b64)).toThrow();
	});

	// AC-2 (acceptance): 48-byte base64 → throws
	it('throws for a 48-byte (too long) key', () => {
		const b64 = randomBytes(48).toString('base64');
		expect(() => validateEncryptionKey(b64)).toThrow();
	});

	// AC-2 (acceptance): non-base64 input → handle gracefully (throw, not crash)
	it('throws gracefully for non-base64 input (wrong length after decode)', () => {
		// 'not-valid-base64!!!' is not a 32-byte key; it may or may not parse, but
		// length check must catch it.  We test both the "parse fails" and "wrong
		// length" paths by using a clearly non-32-byte value.
		expect(() => validateEncryptionKey('!!!invalid!!!')).toThrow();
	});
});

describe('EncryptionService — blob length math', () => {
	// Spec: decoded blob length = 12 (IV) + utf8_bytes(plaintext) + 16 (authTag)
	it('blob decoded length equals 12 + utf8_bytes(plaintext) + 16 for ASCII', () => {
		const key = randomBytes(32) as unknown as Buffer;
		const service = createEncryptionService(key as unknown as Parameters<typeof createEncryptionService>[0]);
		const plaintext = 'hello world'; // 11 UTF-8 bytes
		const blob = service.encrypt(plaintext);
		const decoded = Buffer.from(blob, 'base64');
		const expectedLen = 12 + Buffer.byteLength(plaintext, 'utf8') + 16;
		expect(decoded.length).toBe(expectedLen);
	});

	it('blob decoded length equals 12 + utf8_bytes(plaintext) + 16 for multi-byte UTF-8', () => {
		const key = randomBytes(32) as unknown as Buffer;
		const service = createEncryptionService(key as unknown as Parameters<typeof createEncryptionService>[0]);
		const plaintext = 'é'; // é — 2 UTF-8 bytes
		const blob = service.encrypt(plaintext);
		const decoded = Buffer.from(blob, 'base64');
		const expectedLen = 12 + Buffer.byteLength(plaintext, 'utf8') + 16;
		expect(decoded.length).toBe(expectedLen);
	});

	it('blob decoded length equals 12 + 16 for empty string', () => {
		const key = randomBytes(32) as unknown as Buffer;
		const service = createEncryptionService(key as unknown as Parameters<typeof createEncryptionService>[0]);
		const blob = service.encrypt('');
		const decoded = Buffer.from(blob, 'base64');
		expect(decoded.length).toBe(12 + 16);
	});
});
