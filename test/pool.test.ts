// Unit tests for the bounded-concurrency worker pool used by the Drive initial listing.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mapPool } from "../src/etl/pool.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("processes every item and returns results in input order", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const results = await mapPool(items, 3, async (n) => {
    await tick();
    return n * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
});

test("an empty input resolves to an empty array without calling fn", async () => {
  let calls = 0;
  const results = await mapPool([], 4, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("keeps at most `limit` calls in flight while still saturating the limit", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapPool(items, 3, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    await tick();
    active--;
  });
  assert.equal(maxActive, 3);
});

test("a rejecting item fails the pool with its error; in-flight items finish, queued items never start", async () => {
  const failing = deferred();
  const inFlight = deferred();
  const started: number[] = [];
  const completed: number[] = [];
  const pool = mapPool([0, 1, 2, 3], 2, async (i) => {
    started.push(i);
    if (i === 0) await failing.promise;
    if (i === 1) await inFlight.promise;
    completed.push(i);
  });
  // both workers are busy (items 0 and 1) — fail item 0 while item 1 is still running
  failing.reject(new Error("boom"));
  await tick();
  inFlight.resolve();
  await assert.rejects(pool, /boom/);
  assert.deepEqual(started, [0, 1]); // items 2 and 3 never started after the failure
  assert.deepEqual(completed, [1]); // the item already in flight ran to completion
});

test("rejects a non-positive or fractional limit", async () => {
  await assert.rejects(() => mapPool([1], 0, async (n) => n), /limit/);
  await assert.rejects(() => mapPool([1], 1.5, async (n) => n), /limit/);
});
