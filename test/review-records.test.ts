// Unit tests for the human-decision capture (src/review-records.ts): record id band and identity,
// batch shape (schema + node + facts), optional-field omission, and typed subject pointers.
// Pure functions — no engine, no server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { REVIEW_BAND, reviewRecordBatch, reviewRecordId, type ReviewRecordInput } from "../src/review-records.ts";

const base: ReviewRecordInput = {
  surface: "identities",
  key: "100-200",
  decision: "confirmed",
  proposal: "same-as: Alice = A. Example",
  evidence: "exact normalized email match",
  reviewer: "reviewer",
  at: 1_700_000_000,
  persons: [100, 200],
};

test("reviewRecordId: sits in the Review band, stable for the same decision instance, distinct otherwise", () => {
  const id = reviewRecordId("identities", "100-200", 1_700_000_000, "reviewer");
  assert.ok(id >= REVIEW_BAND && id < REVIEW_BAND + 2 ** 48);
  assert.equal(reviewRecordId("identities", "100-200", 1_700_000_000, "reviewer"), id); // same instance
  assert.notEqual(reviewRecordId("approvals", "100-200", 1_700_000_000, "reviewer"), id); // surface
  assert.notEqual(reviewRecordId("identities", "100-201", 1_700_000_000, "reviewer"), id); // proposal
  assert.notEqual(reviewRecordId("identities", "100-200", 1_700_000_001, "reviewer"), id); // instant
  assert.notEqual(reviewRecordId("identities", "100-200", 1_700_000_000, "other"), id); // reviewer
});

test("reviewRecordBatch: schema + node + facts, every fact stamped with the decision instant", () => {
  const items = reviewRecordBatch(base);
  const id = reviewRecordId(base.surface, base.key, base.at, base.reviewer);
  // the record node is typed ReviewRecord
  const node = items.find((i) => "node" in i);
  assert.deepEqual(node, { node: { id, type: "ReviewRecord" } });
  // the schema rides along (idempotent to redeclare)
  assert.ok(items.some((i) => "type_def" in i && i.type_def.name === "ReviewRecord"));
  assert.ok(items.some((i) => "pred_def" in i && i.pred_def.name === "review-proposal" && i.pred_def.display === true));
  // facts: situation + decision + evidence + reviewer, all valid_from = at, none carries a source
  const facts = items.filter((i) => "fact" in i).map((i) => (i as { fact: { subject: number; predicate: string; object: unknown; valid_from?: number; source?: string } }).fact);
  assert.ok(facts.every((f) => f.subject === id && f.valid_from === base.at && f.source === undefined));
  const byPred = new Map(facts.map((f) => [f.predicate, f.object]));
  assert.deepEqual(byPred.get("review-surface"), { text: "identities" });
  assert.deepEqual(byPred.get("review-decision"), { text: "confirmed" });
  assert.deepEqual(byPred.get("review-proposal"), { text: base.proposal });
  assert.deepEqual(byPred.get("review-evidence"), { text: base.evidence });
  assert.deepEqual(byPred.get("review-reviewer"), { text: "reviewer" });
});

test("reviewRecordBatch: typed subject pointers become edges, one per node", () => {
  const items = reviewRecordBatch({ ...base, surface: "approvals", issues: [7], persons: [100] });
  const facts = items.filter((i) => "fact" in i).map((i) => (i as { fact: { predicate: string; object: unknown } }).fact);
  assert.deepEqual(facts.filter((f) => f.predicate === "review-of-person").map((f) => f.object), [{ node: 100 }]);
  assert.deepEqual(facts.filter((f) => f.predicate === "review-of-issue").map((f) => f.object), [{ node: 7 }]);
  assert.ok(!facts.some((f) => f.predicate === "review-of-document"));
});

test("reviewRecordBatch: absent optionals write no facts — a dismissal without evidence stays lean", () => {
  const items = reviewRecordBatch({ surface: "patterns", key: "p1", decision: "dismissed", proposal: "pattern p1", at: 1 });
  const preds = items.filter((i) => "fact" in i).map((i) => (i as { fact: { predicate: string } }).fact.predicate);
  assert.deepEqual(preds.sort(), ["review-decision", "review-proposal", "review-surface"]);
});
