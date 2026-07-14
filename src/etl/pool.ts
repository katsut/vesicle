// Bounded-concurrency mapper for independent per-item work. Workers pull the next index from a
// shared cursor, so one slow item never stalls the rest of the batch (fixed-size chunking via
// Promise.all would wait for each chunk's slowest member). No external dependency on purpose.
//
// Failure semantics mirror a sequential loop aborting at the failing item: after the first
// rejection no NEW items are started, items already in flight settle, and the pool rejects with
// that first error.

/** Map `fn` over `items` with at most `limit` calls in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`mapPool: limit must be a positive integer, got ${limit}`);
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
  return results;
}
