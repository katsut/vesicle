// Unit tests for the deterministic pattern miner (src/patterns.ts): threshold gating, the greedy
// target selection, exception listing and capping, the observation window, and pattern-id
// stability. Pure functions — no engine, no server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EXCEPTION_CAP, MIN_GROUP_SIZE, minePattern, patternId, type EventObs } from "../src/patterns.ts";

// Target ids stand in for Person nodes (generic names, per the display layer): Alice, Bob, Carol.
const ALICE = 101;
const BOB = 102;
const CAROL = 103;

const ev = (id: number, targets: number[], at = 0): EventObs => ({ id, targets, at });

/** n single-target events with ids starting at `from`. */
const run = (from: number, n: number, target: number): EventObs[] =>
  Array.from({ length: n }, (_, i) => ev(from + i, [target]));

test("minePattern: concentration at the coverage threshold yields a candidate", () => {
  // 8 of 10 events target Alice — exactly MIN_COVERAGE
  const m = minePattern([...run(1, 8, ALICE), ev(9, [BOB]), ev(10, [BOB])]);
  assert.ok(m);
  assert.deepEqual(m.targets, [ALICE]);
  assert.equal(m.support, 8);
  assert.equal(m.total, 10);
  assert.deepEqual(m.exceptions, [9, 10]);
  assert.equal(m.exceptionsOmitted, 0);
});

test("minePattern: concentration below the threshold yields no candidate", () => {
  // 10 events spread 2 apiece over 5 targets — the best pair covers only 4/10
  const events = [201, 202, 203, 204, 205].flatMap((t, i) => [ev(i * 2 + 1, [t]), ev(i * 2 + 2, [t])]);
  assert.equal(minePattern(events), null);
});

test("minePattern: groups below MIN_GROUP_SIZE never yield a candidate", () => {
  // 9 events, ALL on Alice — perfect concentration, but the population is too small
  assert.equal(minePattern(run(1, MIN_GROUP_SIZE - 1, ALICE)), null);
  assert.ok(minePattern(run(1, MIN_GROUP_SIZE, ALICE)));
});

test("minePattern: greedy stops at one target when it alone reaches coverage", () => {
  // Alice covers 0.8 by herself — Bob is NOT padded in even though he would add coverage
  const m = minePattern([...run(1, 8, ALICE), ev(9, [BOB]), ev(10, [CAROL])]);
  assert.ok(m);
  assert.deepEqual(m.targets, [ALICE]);
});

test("minePattern: greedy adds a second target when one is not enough", () => {
  // Alice 5/10, Bob 4/10 — only together do they reach 0.9
  const m = minePattern([...run(1, 5, ALICE), ...run(6, 4, BOB), ev(10, [CAROL])]);
  assert.ok(m);
  assert.deepEqual(m.targets, [ALICE, BOB]);
  assert.equal(m.support, 9);
  assert.deepEqual(m.exceptions, [10]);
});

test("minePattern: multi-target events count once per event, not per grant", () => {
  // doc-access shape: e5/e6 carry BOTH Alice and Bob — Bob's step-2 gain is only the 3 docs
  // Alice does not already cover, and a doubly-granted doc is one covered event, not two
  const events = [
    ...Array.from({ length: 4 }, (_, i) => ev(i + 1, [ALICE])),
    ev(5, [ALICE, BOB]),
    ev(6, [ALICE, BOB]),
    ...Array.from({ length: 3 }, (_, i) => ev(i + 7, [BOB])),
    ev(10, [CAROL]),
  ];
  const m = minePattern(events);
  assert.ok(m);
  assert.deepEqual(m.targets, [ALICE, BOB]);
  assert.equal(m.support, 9);
  assert.equal(m.total, 10);
  assert.deepEqual(m.exceptions, [10]);
});

test("minePattern: events without any target count against coverage", () => {
  // 2 unassigned events among 10 → Alice's 8 still reach 0.8, and the unassigned are the exceptions
  const m = minePattern([...run(1, 8, ALICE), ev(9, []), ev(10, [])]);
  assert.ok(m);
  assert.equal(m.support, 8);
  assert.deepEqual(m.exceptions, [9, 10]);
});

test("minePattern: exceptions are capped at EXCEPTION_CAP with the cut count reported", () => {
  // 120 of 150 on Alice (exactly 0.8) → 30 exceptions: first 20 listed in input order, 10 counted
  const outliers = Array.from({ length: 30 }, (_, i) => ev(1000 + i, [500 + i]));
  const m = minePattern([...run(1, 120, ALICE), ...outliers]);
  assert.ok(m);
  assert.equal(m.support, 120);
  assert.equal(m.total, 150);
  assert.equal(m.exceptions.length, EXCEPTION_CAP);
  assert.deepEqual(m.exceptions, outliers.slice(0, EXCEPTION_CAP).map((e) => e.id));
  assert.equal(m.exceptionsOmitted, 10);
});

test("minePattern: the observation window spans the timestamped events, ignoring unreported times", () => {
  const events = [
    ...Array.from({ length: 8 }, (_, i) => ev(i + 1, [ALICE], 1000 + i * 100)),
    ev(9, [BOB], 0), // unreported — must not drag windowFrom to 0
    ev(10, [BOB], 5000),
  ];
  const m = minePattern(events);
  assert.ok(m);
  assert.equal(m.windowFrom, 1000);
  assert.equal(m.windowTo, 5000);
});

test("patternId: stable for the same (template, group, predicate), distinct otherwise", () => {
  const id = patternId("issue-assignee", 42, "assigned-to");
  assert.equal(patternId("issue-assignee", 42, "assigned-to"), id); // same input → same id
  assert.notEqual(patternId("comment-author", 42, "assigned-to"), id);
  assert.notEqual(patternId("issue-assignee", 43, "assigned-to"), id);
  assert.notEqual(patternId("issue-assignee", 42, "commented-by"), id);
});
