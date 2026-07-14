// Unit tests for the per-lane compression aggregation behind /api/sink/info: pipeline defs + run
// history (most-recent first) → { observed, facts, suppressed } per lane, with unrecorded values
// left absent for the UI to omit.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { laneMetrics, type PipelineDef, type PipelineRun } from "../src/etl/store.ts";

const def = (over: Partial<PipelineDef> & { id: string }): PipelineDef => ({
  name: over.id,
  source: "source-a",
  mode: "poll",
  state: "running",
  ...over,
});

const run = (over: Partial<PipelineRun> & { pipelineId: string }): PipelineRun => ({
  kind: "one-shot",
  startedAt: 1,
  finishedAt: 2,
  events: 0,
  facts: 0,
  error: null,
  ...over,
});

test("a poll lane with no runs reports its durable facts counter; observed and suppressed stay absent", () => {
  const lanes = laneMetrics([def({ id: "lane-a", name: "Lane A", ingested: 42 })], []);
  assert.deepEqual(lanes, [{ id: "lane-a", name: "Lane A", facts: 42 }]);
  assert.ok(!("observed" in lanes[0]!));
  assert.ok(!("suppressed" in lanes[0]!));
});

test("a run-only lane (no def) sums events and facts across its runs and is named by its id", () => {
  const runs = [
    run({ pipelineId: "one-shot-a", events: 3, facts: 12, suppressed: 5 }),
    run({ pipelineId: "one-shot-a", events: 7, facts: 20, suppressed: 1 }),
  ];
  const lanes = laneMetrics([], runs);
  assert.deepEqual(lanes, [{ id: "one-shot-a", name: "one-shot-a", facts: 32, observed: 10, suppressed: 5 }]);
});

test("suppressed comes from the most recent run only, and is omitted when that run has none", () => {
  const runs = [
    run({ pipelineId: "one-shot-a", events: 1, facts: 1 }), // most recent: predates the counter
    run({ pipelineId: "one-shot-a", events: 1, facts: 1, suppressed: 9 }),
  ];
  const lanes = laneMetrics([], runs);
  assert.equal(lanes[0]!.observed, 2);
  assert.ok(!("suppressed" in lanes[0]!));
});

test("a lane with a def and runs combines the def counter with the run totals", () => {
  const lanes = laneMetrics(
    [def({ id: "lane-a", name: "Lane A", ingested: 10 })],
    [run({ pipelineId: "lane-a", events: 4, facts: 6, suppressed: 2 })],
  );
  assert.deepEqual(lanes, [{ id: "lane-a", name: "Lane A", facts: 16, observed: 4, suppressed: 2 }]);
});

test("lanes list defs first (config order), then run-only ids in history order; runs of other lanes never bleed in", () => {
  const lanes = laneMetrics(
    [def({ id: "lane-a", name: "Lane A" }), def({ id: "lane-b", name: "Lane B", ingested: 3 })],
    [run({ pipelineId: "one-shot-a", events: 2, facts: 5 }), run({ pipelineId: "lane-a", events: 1, facts: 1 })],
  );
  assert.deepEqual(lanes.map((l) => l.id), ["lane-a", "lane-b", "one-shot-a"]);
  assert.equal(lanes[1]!.facts, 3);
  assert.ok(!("observed" in lanes[1]!));
});

test("no defs and no runs produce no lanes", () => {
  assert.deepEqual(laneMetrics([], []), []);
});
