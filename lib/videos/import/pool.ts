/**
 * Runs `fn` over `items` with at most `limit` calls in flight and returns the
 * results in input order. `fn` is expected to handle its own failures; a
 * rejection stops the pool and propagates.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
