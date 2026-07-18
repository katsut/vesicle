// Unit tests for the implicit-inference core (src/inferences.ts inferDocProjects): tiering by
// neighborhood strength, the floor and minimum support, same-as identity resolution across id
// bands, and citation of the supporting grantees. Pure function — no engine, no server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { INFER_FLOOR, INFER_MIN_SUPPORT, inferDocProjects, type InferenceInput } from "../src/inferences.ts";

// Ids stand in for nodes: docs 1x, projects 9xx, Drive-band grantees 10x, Backlog-band persons 20x.
const P = 900;
const Q = 901;

const input = (docs: Record<number, number[]>, activity: Record<number, number[]>, sameAs: Record<number, number[]> = {}): InferenceInput => ({
  docs: new Map(Object.entries(docs).map(([k, v]) => [Number(k), v])),
  sameAs: new Map(Object.entries(sameAs).map(([k, v]) => [Number(k), v])),
  activity: new Map(Object.entries(activity).map(([k, v]) => [Number(k), new Set(v)])),
});

test("inferDocProjects: a unanimous neighborhood fills, a majority routes to a human", () => {
  const rows = inferDocProjects(
    input(
      { 11: [101, 102, 103], 12: [101, 102, 103, 104, 105] },
      { 101: [P], 102: [P], 103: [P], 104: [P], 105: [Q] },
    ),
  );
  // doc 11: 3/3 on P → high; doc 12: 4/5 on P → ambiguous (and 1/5 on Q stays under the floor)
  assert.deepEqual(
    rows.map((r) => [r.doc, r.project, r.support, r.resolvable, r.tier]),
    [
      [11, P, 3, 3, "high"],
      [12, P, 4, 5, "ambiguous"],
    ],
  );
});

test("inferDocProjects: below the floor or the minimum support nothing is proposed", () => {
  // 2/4 on each of two projects = exactly at the floor → proposed; 1/4 stays silent
  const atFloor = inferDocProjects(input({ 11: [101, 102, 103, 104] }, { 101: [P], 102: [P], 103: [Q], 104: [Q] }));
  assert.equal(atFloor.length, 2);
  assert.ok(atFloor.every((r) => r.support / r.resolvable >= INFER_FLOOR));
  // only 2 resolvable grantees (< INFER_MIN_SUPPORT) → silent even though unanimous
  const tooSmall = inferDocProjects(input({ 11: [101, 102, 103] }, { 101: [P], 102: [P] }));
  assert.equal(tooSmall.length, 0);
  assert.ok(INFER_MIN_SUPPORT > 2);
});

test("inferDocProjects: grantees with no resolvable activity drop out of the denominator", () => {
  // 5 grantees, 2 unmapped accounts → denominator 3, unanimous on P
  const rows = inferDocProjects(input({ 11: [101, 102, 103, 104, 105] }, { 101: [P], 102: [P], 103: [P] }));
  assert.deepEqual(rows.map((r) => [r.support, r.resolvable, r.tier]), [[3, 3, "high"]]);
});

test("inferDocProjects: same-as resolution bridges bands and cites the counterpart", () => {
  // Drive grantee 101 has no activity itself; its Backlog counterpart 201 works in P
  const rows = inferDocProjects(
    input(
      { 11: [101, 102, 103] },
      { 201: [P], 102: [P], 103: [P] },
      { 101: [201], 201: [101] },
    ),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.supporters, [
    { grantee: 101, via: 201 }, // the citation's middle hop: the same-as counterpart
    { grantee: 102, via: null },
    { grantee: 103, via: null },
  ]);
  assert.equal(rows[0]!.tier, "high");
});

test("inferDocProjects: same-as chains resolve transitively", () => {
  // 101 ↔ 201 ↔ 301 — activity sits two hops away
  const rows = inferDocProjects(
    input(
      { 11: [101, 102, 103] },
      { 301: [P], 102: [P], 103: [P] },
      { 101: [201], 201: [101, 301], 301: [201] },
    ),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.supporters[0], { grantee: 101, via: 301 });
});

test("inferDocProjects: duplicate grants count once and rows come out in stable order", () => {
  const rows = inferDocProjects(
    input(
      { 12: [101, 102, 103], 11: [101, 101, 102, 103] }, // duplicate grantee in doc 11
      { 101: [P, Q], 102: [P, Q], 103: [P, Q] },
    ),
  );
  // both docs, both projects, unanimous each — sorted by (doc, project)
  assert.deepEqual(
    rows.map((r) => [r.doc, r.project, r.support, r.resolvable]),
    [
      [11, P, 3, 3],
      [11, Q, 3, 3],
      [12, P, 3, 3],
      [12, Q, 3, 3],
    ],
  );
});
