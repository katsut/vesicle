// Unit tests for the deterministic pattern miner (src/patterns.ts): threshold gating, the greedy
// target selection, exception listing and capping, the observation window, pattern-id stability,
// the scope-ubiquity demotion, and the temporal stability trace. Pure functions — no engine, no
// server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EXCEPTION_CAP, MAX_TRACE_POINTS, MIN_GROUP_SIZE, minePattern, monthlyPoints, patternId, splitUbiquitousTargets, stabilityTrace, type EventObs } from "../src/patterns.ts";

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

// --- scope-ubiquity demotion -------------------------------------------------------------------

const ADMIN = 100;

/** Folder groups: 3 folders × 5 docs. ADMIN is on every doc except doc 15; each folder also has
 *  its own person (Alice/Bob/Carol) on 4 of its 5 docs. */
function driveShape(): Map<number, EventObs[]> {
  const folder = (from: number, local: number, adminMiss?: number): EventObs[] =>
    Array.from({ length: 5 }, (_, i) => {
      const doc = from + i;
      const targets = doc === adminMiss ? [] : [ADMIN];
      if (i < 4) targets.push(local);
      return ev(doc, targets, 1000 + doc);
    });
  return new Map([
    [1, folder(1, ALICE)],
    [2, folder(6, BOB)],
    [3, folder(11, CAROL, 15)],
  ]);
}

test("splitUbiquitousTargets: a target on ≥90% of all documents is demoted to one scope pattern", () => {
  const { groups, scope } = splitUbiquitousTargets(driveShape());
  // ADMIN reaches 14 of 15 documents (≥ 0.9) → ONE scope-level statement, not three folder wins
  assert.equal(scope.length, 1);
  assert.deepEqual(scope[0], {
    target: ADMIN,
    support: 14,
    total: 15,
    exceptions: [15], // the one document ADMIN cannot reach
    exceptionsOmitted: 0,
    windowFrom: 1001,
    windowTo: 1015,
  });
  // ADMIN is stripped from every folder event; the events themselves stay in the denominators
  for (const events of groups.values()) {
    assert.equal(events.length, 5);
    for (const e of events) assert.ok(!e.targets.includes(ADMIN));
  }
  // the folder-specific people are untouched
  assert.deepEqual(groups.get(1)!.map((e) => e.targets), [[ALICE], [ALICE], [ALICE], [ALICE], []]);
});

test("splitUbiquitousTargets: below the threshold nothing is demoted", () => {
  // ADMIN on 13 of 15 (0.867 < 0.9) — folder mining keeps seeing the full target lists
  const shape = driveShape();
  shape.get(1)![0]!.targets.shift(); // remove ADMIN from doc 1 → 13/15
  const { groups, scope } = splitUbiquitousTargets(shape);
  assert.deepEqual(scope, []);
  assert.equal(groups, shape); // untouched, same map
});

test("splitUbiquitousTargets: fewer than MIN_GROUP_SIZE documents in total never demotes", () => {
  // 9 docs ALL covered by ADMIN — perfect ubiquity, but too small a population to call it
  const shape = new Map([[1, Array.from({ length: MIN_GROUP_SIZE - 1 }, (_, i) => ev(i + 1, [ADMIN]))]]);
  const { scope } = splitUbiquitousTargets(shape);
  assert.deepEqual(scope, []);
});

test("splitUbiquitousTargets: multiple ubiquitous targets each get one scope pattern, widest first", () => {
  const shape = new Map([
    [1, Array.from({ length: 10 }, (_, i) => ev(i + 1, i === 9 ? [ADMIN] : [ADMIN, ALICE]))],
  ]);
  const { scope } = splitUbiquitousTargets(shape);
  assert.deepEqual(scope.map((s) => [s.target, s.support]), [[ADMIN, 10], [ALICE, 9]]);
});

test("splitUbiquitousTargets: folder mining then surfaces the next concentration", () => {
  // Before demotion ADMIN (10/10) wins the greedy pick; after, Alice's 8/10 is the candidate
  const events = Array.from({ length: 10 }, (_, i) => ev(i + 1, i < 8 ? [ADMIN, ALICE] : [ADMIN]));
  const { groups } = splitUbiquitousTargets(new Map([[1, events]]));
  const m = minePattern(groups.get(1)!);
  assert.ok(m);
  assert.deepEqual(m.targets, [ALICE]);
  assert.equal(m.support, 8);
  assert.equal(m.total, 10);
  assert.deepEqual(m.exceptions, [9, 10]);
});

// --- temporal stability trace -------------------------------------------------------------------

const utc = (y: number, mo: number, d = 1): number => Date.UTC(y, mo - 1, d) / 1000;

test("monthlyPoints: UTC month starts inside the window, ends included", () => {
  // window 2026-01-15 .. 2026-04-10 → the month starts strictly inside it
  assert.deepEqual(monthlyPoints(utc(2026, 1, 15), utc(2026, 4, 10)), [utc(2026, 2), utc(2026, 3), utc(2026, 4)]);
  // a window that starts exactly ON a month start keeps that point
  assert.deepEqual(monthlyPoints(utc(2026, 2), utc(2026, 3, 20)), [utc(2026, 2), utc(2026, 3)]);
});

test("monthlyPoints: windows too short for a month boundary, or invalid, yield nothing", () => {
  assert.deepEqual(monthlyPoints(utc(2026, 1, 2), utc(2026, 1, 30)), []); // no boundary inside
  assert.deepEqual(monthlyPoints(0, utc(2026, 1)), []); // unreported window
  assert.deepEqual(monthlyPoints(utc(2026, 2), utc(2026, 1)), []); // inverted
});

test("monthlyPoints: long windows keep only the most recent MAX_TRACE_POINTS months", () => {
  const points = monthlyPoints(utc(2020, 1), utc(2026, 6, 15));
  assert.equal(points.length, MAX_TRACE_POINTS);
  assert.equal(points[points.length - 1], utc(2026, 6)); // the recent end survives the cap
  assert.equal(points[0], utc(2023, 7)); // 36 months back from 2026-06 inclusive
});

test("stabilityTrace: held months, a wobble month naming its actual holder, empty months neutral", () => {
  const months = [
    { at: utc(2026, 1), values: [ALICE, ALICE, ALICE, ALICE, BOB] }, // 4/5 → held
    { at: utc(2026, 2), values: [BOB, BOB, BOB, ALICE, null] }, // 1/4 → wobble, Bob holds
    { at: utc(2026, 3), values: [null, null, null, null, null] }, // nobody existed yet → neutral
    { at: utc(2026, 4), values: [ALICE, ALICE, ALICE, ALICE, ALICE] }, // restored
  ];
  const tr = stabilityTrace(months, [ALICE]);
  assert.equal(tr.measured, 3); // the empty month is not measured
  assert.equal(tr.held, 2);
  assert.deepEqual(tr.slices.map((s) => s.held), [true, false, false, true]);
  assert.deepEqual(tr.slices.map((s) => s.top), [null, BOB, null, null]); // holder named only on wobble
  assert.equal(tr.slices[1]!.population, 4); // nulls shrink the denominator, never count against S
  assert.equal(tr.slices[1]!.covered, 1);
});

test("stabilityTrace: coverage exactly at the threshold holds; top ties break to the smaller id", () => {
  const at = utc(2026, 1);
  // 4 of 5 on the set = 0.8 → held
  assert.equal(stabilityTrace([{ at, values: [ALICE, ALICE, ALICE, ALICE, BOB] }], [ALICE]).held, 1);
  // wobble with BOB and CAROL at 2 apiece → the smaller id wins the "top" slot
  const tr = stabilityTrace([{ at, values: [BOB, BOB, CAROL, CAROL, ALICE] }], [ALICE]);
  assert.equal(tr.slices[0]!.top, BOB);
});

test("stabilityTrace: a two-target set covers with either member", () => {
  const at = utc(2026, 1);
  const tr = stabilityTrace([{ at, values: [ALICE, BOB, ALICE, BOB, CAROL] }], [ALICE, BOB]);
  assert.equal(tr.slices[0]!.covered, 4);
  assert.equal(tr.held, 1);
});
