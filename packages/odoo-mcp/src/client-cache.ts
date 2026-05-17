import type { OdooClient, OdooSession } from '@netlinksinc/odoo-client';

// Minimal ambient declarations — avoids @types/node dependency.
declare const setInterval: (callback: () => void, ms: number) => number;
declare const clearInterval: (handle: number) => void;

export interface CachedClient {
  client: OdooClient;
  session: OdooSession;
  lastUsedAt: number; // Date.now() timestamp
}

export interface ClientCache {
  get(email: string): CachedClient | undefined;
  set(email: string, entry: CachedClient): void;
  evict(email: string): void;
  size(): number;
  startSweep(): void;
  stopSweep(): void;
}

export function createClientCache(options: {
  maxSize: number;
  idleTtlMs: number;
  sweepIntervalMs: number;
}): ClientCache {
  const map = new Map<string, CachedClient>();
  let sweepHandle: number | undefined;

  return {
    get(email: string): CachedClient | undefined {
      const entry = map.get(email);
      if (entry === undefined) return undefined;
      // Update lastUsedAt and move to end (LRU access pattern).
      entry.lastUsedAt = Date.now();
      map.delete(email);
      map.set(email, entry);
      return entry;
    },

    set(email: string, entry: CachedClient): void {
      // Remove existing entry to re-insert at end.
      if (map.has(email)) {
        map.delete(email);
      }
      // Evict the LRU (first) entry if at capacity.
      if (map.size >= options.maxSize) {
        const lruKey = map.keys().next().value;
        if (lruKey !== undefined) {
          map.delete(lruKey);
        }
      }
      map.set(email, entry);
    },

    evict(email: string): void {
      map.delete(email);
    },

    size(): number {
      return map.size;
    },

    startSweep(): void {
      // Idempotent — do nothing if already running.
      if (sweepHandle !== undefined) return;
      sweepHandle = setInterval(() => {
        const now = Date.now();
        for (const [email, entry] of map) {
          if (now - entry.lastUsedAt > options.idleTtlMs) {
            map.delete(email);
          }
        }
      }, options.sweepIntervalMs);
    },

    stopSweep(): void {
      if (sweepHandle === undefined) return;
      clearInterval(sweepHandle);
      sweepHandle = undefined;
    },
  };
}
