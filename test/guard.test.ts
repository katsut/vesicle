// Unit tests for the late-arrival guard's repair decision (stubbed engine reads/writes).
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BatchItem } from "../src/etl/types.ts";
import type { IngestStats, Sink } from "../src/etl/sink.ts";
import type { PointRecord, Stroma } from "../src/stroma.ts";
import { repairLateArrivals } from "../src/etl/guard.ts";

const stats: IngestStats = {};

function stubs(winner: PointRecord) {
  const ingested: BatchItem[][] = [];
  const db = { ensureAuthed: async () => {}, pointRecord: async () => winner } as unknown as Stroma;
  const sink: Sink = {
    health: async () => true,
    stats: async () => ({}),
    ingest: async (batch) => {
      ingested.push(batch);
      return stats;
    },
  };
  return { db, sink, ingested };
}

const batch = (object: { text: string }, validFrom: number): BatchItem[] => [
  { pred_def: { name: "name", cardinality: "one", domain: "Person", range_value: "text" } },
  { fact: { subject: 1, predicate: "name", object, valid_from: validFrom } },
];

test("older re-send with the SAME value triggers no repair", async () => {
  const { db, sink, ingested } = stubs({ one: { text: "Alice" }, valid_from: 500 });
  const { repairs } = await repairLateArrivals(db, sink, batch({ text: "Alice" }, 0), { pipelineId: "t" });
  assert.equal(repairs.length, 0);
  assert.equal(ingested.length, 1);
});

test("older write with a DIFFERENT value still repairs the winner back", async () => {
  const { db, sink, ingested } = stubs({ one: { text: "Alice" }, valid_from: 500 });
  const { repairs } = await repairLateArrivals(db, sink, batch({ text: "Bob" }, 100), { pipelineId: "t" });
  assert.equal(repairs.length, 1);
  assert.equal(ingested.length, 2);
  const followUp = ingested[1]![0] as { fact: { object: { text: string }; valid_from: number } };
  assert.deepEqual(followUp.fact.object, { text: "Alice" });
  assert.equal(followUp.fact.valid_from, 500);
});

test("in-order write (newer than the winner) triggers no repair", async () => {
  const { db, sink, ingested } = stubs({ one: { text: "Alice" }, valid_from: 500 });
  const { repairs } = await repairLateArrivals(db, sink, batch({ text: "Bob" }, 600), { pipelineId: "t" });
  assert.equal(repairs.length, 0);
  assert.equal(ingested.length, 1);
});

test("a late value against a newer close is still repaired (close re-asserted)", async () => {
  const { db, sink, ingested } = stubs({ one: null, closed_from: 700 });
  const { repairs } = await repairLateArrivals(db, sink, batch({ text: "Alice" }, 100), { pipelineId: "t" });
  assert.equal(repairs.length, 1);
  assert.equal(ingested.length, 2);
  assert.ok("close" in ingested[1]![0]!);
});
