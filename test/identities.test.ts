// Unit tests for the deterministic half of identity resolution (src/identities.ts): Person id-band
// classification, cross-band candidate pairing, and the bulk-confirm selection. Pure functions —
// no engine, no server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pairPersons, personBand, selectEmailExact, type Candidate, type PersonInfo } from "../src/identities.ts";

// Band anchors (src/backlog.ts BASE.Person, src/gdrive.ts BAND.Person)
const HR_ID = 42;
const BACKLOG_ID = 1_000_000_000_000 + 7;
const DRIVE_ID = 7 * 2 ** 48 + 99;

const person = (id: number, name: string | null, email: string | null = null): PersonInfo => ({ id, name, email });

test("personBand: classifies the three Person id bands", () => {
  assert.equal(personBand(HR_ID), "hr");
  assert.equal(personBand(999_999_999_999), "hr"); // top of the small-id band
  assert.equal(personBand(1_000_000_000_000), "backlog");
  assert.equal(personBand(BACKLOG_ID), "backlog");
  assert.equal(personBand(7 * 2 ** 48), "drive");
  assert.equal(personBand(DRIVE_ID), "drive");
});

test("personBand: ids outside every Person band are null", () => {
  assert.equal(personBand(2_000_000_000_000), null); // Backlog Project band
  assert.equal(personBand(3_000_000_000_005), null); // Backlog Issue band
  assert.equal(personBand(5 * 2 ** 48 + 1), null); // Drive Document band
  assert.equal(personBand(8 * 2 ** 48), null); // extracted-entity band
});

test("pairPersons: name token sets match across bands — 'jane.doe' ≡ 'Jane Doe'", () => {
  const pairs = pairPersons([person(DRIVE_ID, "jane.doe"), person(BACKLOG_ID, "Jane Doe")]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.evidence, "name");
  assert.equal(pairs[0]!.a.id, BACKLOG_ID); // pair ordered a.id < b.id
  assert.equal(pairs[0]!.b.id, DRIVE_ID);
});

test("pairPersons: normalized email equality is email evidence, and outranks a name match", () => {
  const pairs = pairPersons([
    person(BACKLOG_ID, "Jane Doe", "  Jane.Doe@Example.com "),
    person(DRIVE_ID, "jane.doe", "jane.doe@example.com"),
  ]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.evidence, "email");
});

test("pairPersons: different emails give no email evidence — a name match still pairs", () => {
  // the observed live duplicate: one human, two sources, two registered emails
  const named = pairPersons([
    person(BACKLOG_ID, "Jane Doe", "jane.doe@example.com"),
    person(DRIVE_ID, "jane.doe", "jane@example.org"),
  ]);
  assert.equal(named.length, 1);
  assert.equal(named[0]!.evidence, "name");

  const unrelated = pairPersons([
    person(BACKLOG_ID, "Jane Doe", "jane.doe@example.com"),
    person(DRIVE_ID, "John Smith", "john@example.org"),
  ]);
  assert.deepEqual(unrelated, []);
});

test("pairPersons: same-band pairs are excluded even on identical email", () => {
  const pairs = pairPersons([
    person(BACKLOG_ID, "Jane Doe", "jane@example.com"),
    person(BACKLOG_ID + 1, "J. Doe", "jane@example.com"),
  ]);
  assert.deepEqual(pairs, []);
});

test("pairPersons: '(deleted account)' placeholders are excluded", () => {
  // without the exclusion these two-token names would pair
  const pairs = pairPersons([person(DRIVE_ID, "(deleted account)"), person(BACKLOG_ID, "(deleted account)")]);
  assert.deepEqual(pairs, []);
});

test("pairPersons: single-token names are too weak to pair", () => {
  const pairs = pairPersons([person(DRIVE_ID, "Alice"), person(BACKLOG_ID, "alice")]);
  assert.deepEqual(pairs, []);
});

test("pairPersons: ids outside the Person bands never pair", () => {
  const pairs = pairPersons([person(3_000_000_000_005, "Jane Doe"), person(HR_ID, "jane doe")]);
  assert.deepEqual(pairs, []);
});

// --- selectEmailExact: the bulk-confirm selection ---

const candidate = (
  aId: number,
  bId: number,
  evidence: "email" | "name",
  confirmed = false,
): Candidate => ({
  a: person(aId, "Alice Smith", "alice@example.com"),
  b: person(bId, "Alice Smith", "alice@example.com"),
  evidence,
  confirmed,
});

test("selectEmailExact: only email-evidence pairs are selected — name-token never qualifies", () => {
  const email = candidate(HR_ID, BACKLOG_ID, "email");
  const name = candidate(HR_ID + 1, DRIVE_ID, "name");
  assert.deepEqual(selectEmailExact([email, name], []), [email]);
});

test("selectEmailExact: dismissed pairs are excluded", () => {
  const open = candidate(HR_ID, BACKLOG_ID, "email");
  const dismissed = candidate(HR_ID + 1, DRIVE_ID, "email");
  assert.deepEqual(selectEmailExact([open, dismissed], [[HR_ID + 1, DRIVE_ID]]), [open]);
});

test("selectEmailExact: already-confirmed pairs are excluded", () => {
  const open = candidate(HR_ID, BACKLOG_ID, "email");
  const confirmed = candidate(HR_ID + 1, DRIVE_ID, "email", true);
  assert.deepEqual(selectEmailExact([open, confirmed], []), [open]);
});

test("selectEmailExact: empty when nothing is open", () => {
  const name = candidate(HR_ID, DRIVE_ID, "name");
  const dismissed = candidate(HR_ID + 1, BACKLOG_ID, "email");
  assert.deepEqual(selectEmailExact([name, dismissed], [[HR_ID + 1, BACKLOG_ID]]), []);
});
