export class BoundedPromiseCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; promise: Promise<T> }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  getOrCreate(key: string, factory: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) return current.promise;
    if (current) this.entries.delete(key);

    const promise = factory();
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, promise });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    promise.catch(() => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
    });
    return promise;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}