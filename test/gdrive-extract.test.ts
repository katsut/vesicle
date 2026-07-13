// Unit tests for the Drive body lane's deterministic pieces (no network, no LLM):
// funnel classification, claim → batch mapping (band, labels, valid_from, provenance,
// requires-floor), and model-output parsing.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DriveFile } from "../src/gdrive-api.ts";
import type { SharedModel } from "../src/model.ts";
import { nid } from "../src/gdrive.ts";
import {
  CLAIM_BAND,
  DEFAULT_PATTERN,
  buildDocPrompt,
  claimNid,
  claimsToBatch,
  classifyFiles,
  parseClaims,
  type DocClaim,
  type DocPattern,
} from "../src/gdrive-extract.ts";
import type { BatchItem, Fact } from "../src/etl/types.ts";

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

const factsOf = (items: BatchItem[]): Fact[] =>
  items.filter((i): i is { fact: Fact } => "fact" in i).map((i) => i.fact);
const nodesOf = (items: BatchItem[]) =>
  items.filter((i): i is Extract<BatchItem, { node: unknown }> => "node" in i).map((i) => i.node);

const modelWithFloors = (floors: Record<string, number>): SharedModel => ({
  types: [],
  predicates: Object.entries(floors).map(([name, sensitivity]) => ({
    name,
    cardinality: "one",
    domain: "Rule",
    range_value: "text",
    sensitivity,
  })),
});

const PATTERN: DocPattern = {
  entity_types: ["Rule", "Section"],
  predicates: [
    { name: "rule-title", from: "Rule", to: "text", kind: "value", card: "one" },
    { name: "rule-text", from: "Rule", to: "text", kind: "value", card: "one" },
    { name: "in-section", from: "Rule", to: "Section", kind: "edge", card: "one" },
  ],
  date_field: "effective-from",
};

// --- funnel classification -------------------------------------------------------------------------

test("classifyFiles: PDFs and Google Docs readable, everything else counted per mimeType", () => {
  const files: DriveFile[] = [
    { id: "p1", name: "Security Policy.pdf", mimeType: "application/pdf", permissions: [{ type: "domain" }] },
    { id: "d1", name: "Onboarding Guide", mimeType: "application/vnd.google-apps.document", permissions: [] },
    { id: "s1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" },
    { id: "s2", name: "Headcount", mimeType: "application/vnd.google-apps.spreadsheet" },
    { id: "i1", name: "diagram.png", mimeType: "image/png" },
    { id: "f1", name: "Archive", mimeType: "application/vnd.google-apps.folder" },
  ];
  const { files: readable, skipped } = classifyFiles(files);
  assert.deepEqual(readable.map((f) => f.id), ["p1", "d1"]);
  assert.equal(readable[0]!.label, 1); // domain grant → internal
  assert.equal(readable[1]!.label, 3); // empty ACL, no non-owner principals → restricted
  assert.deepEqual(skipped, {
    "application/vnd.google-apps.spreadsheet": 2,
    "image/png": 1,
    "application/vnd.google-apps.folder": 1,
  });
});

test("classifyFiles: draft heuristic flags drafts (incl. localized markers), still listed", () => {
  const mk = (id: string, name: string): DriveFile => ({ id, name, mimeType: "application/pdf", permissions: [] });
  const { files } = classifyFiles([
    mk("a", "Policy draft.pdf"),
    mk("b", "規程_下書き.pdf"),
    mk("c", "Handbook copy.pdf"),
    mk("d", "Rules_v2.pdf"),
    mk("e", "Security Policy.pdf"),
  ]);
  assert.deepEqual(files.map((f) => f.draft), [true, true, true, true, false]);
  assert.equal(files.length, 5); // drafts are listed, only pre-deselected client-side
});

// --- claim → batch mapping ---------------------------------------------------------------------------

test("claimsToBatch: extracted entities mint in the 8·2^48 band", () => {
  const claims: DocClaim[] = [
    { subject: "Rule 4.2", subjectType: "Rule", predicate: "rule-title", object: "Expenses" },
    { subject: "Rule 4.2", subjectType: "Rule", predicate: "in-section", object: "Section 4", objectType: "Section" },
  ];
  const { items } = claimsToBatch({ fileId: FILE_ID, docLabel: 1, pattern: PATTERN, claims, model: modelWithFloors({}) });
  const nodes = nodesOf(items);
  assert.equal(nodes.length, 2);
  for (const n of nodes) {
    assert.ok(n.id >= 8 * 2 ** 48 && n.id < 9 * 2 ** 48, `node ${n.id} outside the claim band`);
  }
  assert.equal(CLAIM_BAND, 8 * 2 ** 48);
  assert.equal(nodes[0]!.id, claimNid(FILE_ID, "Rule", "Rule 4.2"));
});

test("claimsToBatch: node label = max(doc tier, predicate floor) — floor raises, never lowers", () => {
  const claims: DocClaim[] = [{ subject: "Rule 1", subjectType: "Rule", predicate: "rule-text", object: "…" }];
  // doc tier 1 + floor 2 → 2
  const a = claimsToBatch({ fileId: FILE_ID, docLabel: 1, pattern: PATTERN, claims, model: modelWithFloors({ "rule-text": 2 }) });
  assert.equal(nodesOf(a.items)[0]!.label, 2);
  // doc tier 3 + floor 1 → 3 (never lower than the document's)
  const b = claimsToBatch({ fileId: FILE_ID, docLabel: 3, pattern: PATTERN, claims, model: modelWithFloors({ "rule-text": 1 }) });
  assert.equal(nodesOf(b.items)[0]!.label, 3);
  // no floor → the document's tier
  const c = claimsToBatch({ fileId: FILE_ID, docLabel: 2, pattern: PATTERN, claims, model: modelWithFloors({}) });
  assert.equal(nodesOf(c.items)[0]!.label, 2);
});

test("claimsToBatch: valid_from = effective date when the claim states one, else modifiedTime", () => {
  const claims: DocClaim[] = [
    { subject: "Rule 1", subjectType: "Rule", predicate: "rule-text", object: "New rule", effectiveFrom: "2024-04-01" },
    { subject: "Rule 2", subjectType: "Rule", predicate: "rule-text", object: "Old rule" },
  ];
  const modifiedTime = "2026-01-15T09:30:00Z";
  const { items } = claimsToBatch({ fileId: FILE_ID, docLabel: 1, modifiedTime, pattern: PATTERN, claims, model: modelWithFloors({}) });
  const facts = factsOf(items);
  assert.equal(facts[0]!.valid_from, Math.floor(Date.parse("2024-04-01") / 1000));
  assert.equal(facts[1]!.valid_from, Math.floor(Date.parse(modifiedTime) / 1000));
});

test("claimsToBatch: every fact carries explicit provenance drive:<fileId>", () => {
  const claims: DocClaim[] = [
    { subject: "Rule 1", subjectType: "Rule", predicate: "rule-title", object: "T" },
    { subject: "Rule 1", subjectType: "Rule", predicate: "rule-text", object: "B", effectiveFrom: "2025-01-01" },
    { subject: "Rule 1", subjectType: "Rule", predicate: "in-section", object: "S1", objectType: "Section" },
  ];
  const { items, factCount } = claimsToBatch({
    fileId: FILE_ID, docLabel: 1, pattern: PATTERN, claims, model: modelWithFloors({ "rule-text": 2 }),
  });
  const facts = factsOf(items);
  assert.equal(facts.length, factCount);
  assert.ok(facts.length >= 3);
  for (const f of facts) assert.equal(f.source, `drive:${FILE_ID}`);
});

test("claimsToBatch: requires-floor on the Document node = max floor over claim predicates alone", () => {
  const claims: DocClaim[] = [
    { subject: "Rule 1", subjectType: "Rule", predicate: "rule-title", object: "T" }, // floor 2
    { subject: "Rule 1", subjectType: "Rule", predicate: "rule-text", object: "B" }, // floor 3
  ];
  // observed doc tier 1 must NOT cap or join the requirement — floors alone
  const { items, requiresFloor } = claimsToBatch({
    fileId: FILE_ID, docLabel: 1, modifiedTime: "2026-01-15T09:30:00Z", pattern: PATTERN, claims,
    model: modelWithFloors({ "rule-title": 2, "rule-text": 3 }),
  });
  assert.equal(requiresFloor, 3);
  const rf = factsOf(items).find((f) => f.predicate === "requires-floor");
  assert.ok(rf, "requires-floor fact missing");
  assert.deepEqual(rf!.object, { int: 3 });
  assert.equal(rf!.subject, nid("Document", FILE_ID)); // the structural lane's Document node
  assert.equal(rf!.source, `drive:${FILE_ID}`);
  assert.equal(rf!.valid_from, Math.floor(Date.parse("2026-01-15T09:30:00Z") / 1000));
  assert.ok(items.some((i) => "pred_def" in i && i.pred_def.name === "requires-floor"), "requires-floor pred_def missing");
});

test("claimsToBatch: no floors → no requires-floor fact (and no def)", () => {
  const claims: DocClaim[] = [{ subject: "Rule 1", subjectType: "Rule", predicate: "rule-text", object: "B" }];
  const { items, requiresFloor } = claimsToBatch({
    fileId: FILE_ID, docLabel: 3, pattern: PATTERN, claims, model: modelWithFloors({}),
  });
  assert.equal(requiresFloor, null);
  assert.ok(!factsOf(items).some((f) => f.predicate === "requires-floor"));
  assert.ok(!items.some((i) => "pred_def" in i && i.pred_def.name === "requires-floor"));
});

// --- model-output parsing -----------------------------------------------------------------------------

test("parseClaims: drops out-of-pattern facts, defaults types, keeps effectiveFrom", () => {
  const text = `\`\`\`json
{ "facts": [
  { "subject": "Rule 1", "predicate": "rule-text", "object": "Text", "effectiveFrom": "2024-04-01" },
  { "subject": "Rule 1", "predicate": "in-section", "object": "Section 2" },
  { "subject": "Rule 1", "predicate": "made-up-predicate", "object": "x" },
  { "subject": "", "predicate": "rule-text", "object": "no subject" }
] }
\`\`\``;
  const claims = parseClaims(text, PATTERN);
  assert.equal(claims.length, 2);
  assert.equal(claims[0]!.subjectType, "Rule"); // defaulted from the predicate's domain
  assert.equal(claims[0]!.effectiveFrom, "2024-04-01");
  assert.equal(claims[0]!.objectType, undefined); // value predicate
  assert.equal(claims[1]!.objectType, "Section"); // edge predicate → defaulted from the range
});

test("buildDocPrompt: PDF references the attachment, text embeds the document, date field instructed", () => {
  const pdf = buildDocPrompt(DEFAULT_PATTERN, { kind: "pdf", base64: "unused" });
  assert.ok(pdf.includes("attached PDF"));
  assert.ok(pdf.includes("effective-from"));
  assert.ok(pdf.includes("effectiveFrom"));
  const txt = buildDocPrompt(DEFAULT_PATTERN, { kind: "text", text: "Rule 1 applies to everyone." });
  assert.ok(txt.includes("Rule 1 applies to everyone."));
  assert.ok(!txt.includes("attached PDF"));
});

test("claimsToBatch: a shared logicalDocId lands the same provision from two revisions on one node", () => {
  const claims: DocClaim[] = [
    { subject: "Rule 4.2", subjectType: "Rule", predicate: "rule-title", object: "Expenses" },
  ];
  const common = { docLabel: 1, pattern: PATTERN, model: modelWithFloors({}) };
  const v1 = claimsToBatch({ fileId: "file-v1", logicalDocId: "policy-x", claims, ...common });
  const v2 = claimsToBatch({ fileId: "file-v2", logicalDocId: "policy-x", claims, ...common });
  const id1 = nodesOf(v1.items)[0]!.id;
  const id2 = nodesOf(v2.items)[0]!.id;
  assert.equal(id1, id2); // same logical document ⇒ same claim node ⇒ valid_from supersession connects revisions
  assert.equal(id1, claimNid("policy-x", "Rule", "Rule 4.2"));
  // provenance stays the ACTUAL revision file
  const srcOf = (items: typeof v1.items) =>
    items.flatMap((i) => ("fact" in i ? [i.fact.source] : []))[0];
  assert.equal(srcOf(v1.items), "drive:file-v1");
  assert.equal(srcOf(v2.items), "drive:file-v2");
  // and without logicalDocId the key falls back to the fileId (unchanged behavior)
  const solo = claimsToBatch({ fileId: "file-v1", claims, ...common });
  assert.equal(nodesOf(solo.items)[0]!.id, claimNid("file-v1", "Rule", "Rule 4.2"));
});
