export interface MemoryCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

interface CacheItem<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache<T = unknown> {
  private readonly items = new Map<string, CacheItem<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 512);
    this.ttlMs = Math.max(1, options.ttlMs ?? 5_000);
  }

  get(key: string, now = Date.now()): T | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expiresAt <= now) {
      this.items.delete(key);
      return undefined;
    }
    this.items.delete(key);
    this.items.set(key, item);
    return structuredClone(item.value);
  }

  set(key: string, value: T, now = Date.now()): void {
    this.items.delete(key);
    this.items.set(key, { value: structuredClone(value), expiresAt: now + this.ttlMs });
    while (this.items.size > this.maxEntries) {
      const oldest = this.items.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.items.delete(oldest);
    }
  }

  delete(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.items.keys()) if (key.startsWith(prefix)) this.items.delete(key);
  }

  get size(): number {
    return this.items.size;
  }
}
