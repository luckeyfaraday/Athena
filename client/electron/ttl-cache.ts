/**
 * Memoize an async factory for a fixed time-to-live.
 *
 * The first call — and the first call after the cached value expires — invokes
 * the factory and shares the in-flight promise with every concurrent caller, so
 * a workspace-independent scan runs once instead of once per caller. Rejections
 * are never cached: a failed attempt clears the slot so the next call retries.
 */
export function memoizeAsyncWithTtl<T>(ttlMs: number, factory: () => Promise<T>): () => Promise<T> {
  let cache: { expiresAt: number; promise: Promise<T> } | null = null;
  return () => {
    if (cache && cache.expiresAt > Date.now()) return cache.promise;
    const promise = factory();
    const entry = { expiresAt: Date.now() + ttlMs, promise };
    cache = entry;
    void promise.catch(() => {
      if (cache === entry) cache = null;
    });
    return promise;
  };
}
