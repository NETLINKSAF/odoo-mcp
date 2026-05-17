import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OdooClient, OdooSession } from '@netlinksinc/odoo-client';
import { createClientCache } from '../src/client-cache.js';
import type { CachedClient } from '../src/client-cache.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubClient = {} as OdooClient;
const stubSession: OdooSession = {
	uid: 1,
	companyId: 1,
	allowedCompanyIds: [1],
	userContext: {},
};

function entry(): CachedClient {
	return { client: stubClient, session: stubSession, lastUsedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Shared cache instance — recreated per test group as needed
// ---------------------------------------------------------------------------

let cache: ReturnType<typeof createClientCache>;

afterEach(() => {
	// Always stop sweep to avoid timer leaks between tests.
	cache.stopSweep();
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. get on empty cache → undefined
// ---------------------------------------------------------------------------

describe('get on empty cache', () => {
	beforeEach(() => {
		cache = createClientCache({ maxSize: 10, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('returns undefined for a key that was never set', () => {
		expect(cache.get('nobody@example.com')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 2. set then get → returns the inserted entry
// ---------------------------------------------------------------------------

describe('set then get', () => {
	beforeEach(() => {
		cache = createClientCache({ maxSize: 10, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('returns the entry that was set', () => {
		const e = entry();
		cache.set('user@example.com', e);
		const result = cache.get('user@example.com');
		expect(result).toBeDefined();
		expect(result?.client).toBe(stubClient);
		expect(result?.session).toBe(stubSession);
	});
});

// ---------------------------------------------------------------------------
// 3. get updates lastUsedAt
// ---------------------------------------------------------------------------

describe('get updates lastUsedAt', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cache = createClientCache({ maxSize: 10, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('get updates lastUsedAt to current time', () => {
		vi.setSystemTime(1_000_000);
		const e = entry();
		cache.set('user@example.com', e);

		// Advance time before get
		vi.setSystemTime(1_500_000);
		const result = cache.get('user@example.com');

		expect(result?.lastUsedAt).toBe(1_500_000);
	});
});

// ---------------------------------------------------------------------------
// 4. LRU eviction: maxSize:3, set 4 distinct emails → first evicted
// ---------------------------------------------------------------------------

describe('LRU eviction', () => {
	beforeEach(() => {
		cache = createClientCache({ maxSize: 3, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('evicts the first inserted entry when maxSize is exceeded', () => {
		cache.set('a@example.com', entry());
		cache.set('b@example.com', entry());
		cache.set('c@example.com', entry());
		cache.set('d@example.com', entry());

		// a@ was the LRU entry — must be gone
		expect(cache.get('a@example.com')).toBeUndefined();
		// The rest must still be present
		expect(cache.get('b@example.com')).toBeDefined();
		expect(cache.get('c@example.com')).toBeDefined();
		expect(cache.get('d@example.com')).toBeDefined();
		// Size stays at maxSize
		expect(cache.size()).toBe(3);
	});

	it('promotes a recently accessed entry so it is not evicted next', () => {
		cache.set('a@example.com', entry());
		cache.set('b@example.com', entry());
		cache.set('c@example.com', entry());
		// Access a@ so it becomes most-recently-used
		cache.get('a@example.com');
		// Adding d@ should now evict b@ (LRU)
		cache.set('d@example.com', entry());

		expect(cache.get('b@example.com')).toBeUndefined();
		expect(cache.get('a@example.com')).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 5. evict non-existent email → no error
// ---------------------------------------------------------------------------

describe('evict non-existent key', () => {
	beforeEach(() => {
		cache = createClientCache({ maxSize: 10, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('does not throw when evicting a key that was never set', () => {
		expect(() => cache.evict('ghost@example.com')).not.toThrow();
	});

	it('evict removes the entry if it exists', () => {
		cache.set('user@example.com', entry());
		cache.evict('user@example.com');
		expect(cache.get('user@example.com')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 6. Idle sweep: entry is evicted after idleTtlMs elapses
// ---------------------------------------------------------------------------

describe('idle sweep eviction', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cache = createClientCache({ maxSize: 10, idleTtlMs: 1_000, sweepIntervalMs: 500 });
	});

	it('evicts an idle entry after idleTtlMs elapses', () => {
		vi.setSystemTime(0);
		cache.set('idle@example.com', entry());
		cache.startSweep();

		// Advance past idleTtlMs (1000ms) + at least one sweep interval (500ms)
		vi.advanceTimersByTime(1_500);

		expect(cache.get('idle@example.com')).toBeUndefined();
	});

	it('does not evict an entry that was recently accessed', () => {
		vi.setSystemTime(0);
		cache.set('active@example.com', entry());
		cache.startSweep();

		// Access entry at 800ms — refreshes lastUsedAt
		vi.advanceTimersByTime(800);
		cache.get('active@example.com');

		// Advance another 600ms — total 1400ms but only 600ms since last access
		vi.advanceTimersByTime(600);

		// Entry should still be present (only 600ms idle < 1000ms ttl)
		expect(cache.size()).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// T-15: get() extends effective TTL — entry survives past original expiry
// ---------------------------------------------------------------------------

describe('T-15: get() extends TTL via lastUsedAt refresh', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cache = createClientCache({ maxSize: 10, idleTtlMs: 1_000, sweepIntervalMs: 300 });
	});

	it('entry accessed at partial TTL survives past the original expiry time', () => {
		// Set entry at t=0 with idleTtlMs=1000ms, sweepIntervalMs=300ms.
		vi.setSystemTime(0);
		// Create entry with lastUsedAt=0.
		cache.set('user@t15.com', { client: {} as OdooClient, session: stubSession, lastUsedAt: 0 });
		cache.startSweep();

		// Advance 600ms (< TTL). Sweeps at t=300 and t=600.
		// At t=300: now=300, lastUsedAt=0, diff=300 < 1000 → not evicted.
		// At t=600: sweep runs, then get() updates lastUsedAt to 600.
		vi.advanceTimersByTime(600);
		const result = cache.get('user@t15.com');
		expect(result).toBeDefined();
		// lastUsedAt must have been updated to 600.
		expect(result?.lastUsedAt).toBe(600);

		// Advance to t=1100 (500ms more). Sweeps at t=900.
		// At t=900: now=900, lastUsedAt=600, diff=300 < 1000 → not evicted.
		// Without the get() at t=600, the entry would have been evicted at t=1200 sweep.
		vi.advanceTimersByTime(500);
		// Entry still alive (only 500ms since last access < 1000ms TTL).
		expect(cache.size()).toBe(1);

		// Advance to t=2200 (1100ms more). Sweeps at t=1200, t=1500, t=1800, t=2100.
		// At t=1200: now=1200, lastUsedAt=600, diff=600 < 1000 → not evicted.
		// At t=1500: now=1500, lastUsedAt=600, diff=900 < 1000 → not evicted.
		// At t=1800: now=1800, lastUsedAt=600, diff=1200 > 1000 → EVICTED.
		vi.advanceTimersByTime(1_100);
		expect(cache.size()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// 7. stopSweep before startSweep → no error
// ---------------------------------------------------------------------------

describe('stopSweep before startSweep', () => {
	beforeEach(() => {
		cache = createClientCache({ maxSize: 10, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('does not throw when stopSweep is called before startSweep', () => {
		expect(() => cache.stopSweep()).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 8. startSweep twice → no error (idempotent)
// ---------------------------------------------------------------------------

describe('startSweep idempotent', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cache = createClientCache({ maxSize: 10, idleTtlMs: 60_000, sweepIntervalMs: 5_000 });
	});

	it('does not throw when startSweep is called twice', () => {
		expect(() => {
			cache.startSweep();
			cache.startSweep();
		}).not.toThrow();
	});

	it('calling startSweep twice does not double-sweep entries', () => {
		vi.setSystemTime(0);
		cache.set('user@example.com', entry());
		cache.startSweep();
		cache.startSweep(); // second call is a no-op

		// Advance past idleTtlMs — should still only sweep once per interval
		vi.advanceTimersByTime(5_000);
		// Entry is still fresh (idleTtlMs = 60s), so it should not be evicted
		expect(cache.size()).toBe(1);
	});
});
