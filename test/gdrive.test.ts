// Unit tests for the Drive structural lane's deterministic pieces (no network).
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DriveFile } from "../src/gdrive-api.ts";
import { driveFileToBatch, driveRootBatch, grantClosures, hash48, nid } from "../src/gdrive.ts";

test("driveRootBatch names the shared drive's root Folder node", () => {
  const items = driveRootBatch("0Aexample", "Team Drive", 1_700_000_000_000);
  const root = nid("Folder", "0Aexample");
  const node = items.find((i) => "node" in i && i.node.id === root);
  assert.ok(node, "root Folder node present");
  const facts = items.filter((i) => "fact" in i).map((i) => (i as { fact: { subject: number; predicate: string; object: unknown; valid_from: number } }).fact);
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0], { subject: root, predicate: "folder-name", object: { text: "Team Drive" }, valid_from: 1_700_000_000_000 });
});

test("person-identity facts carry valid_from 0, file facts carry the file's time", () => {
  const file: DriveFile = {
    id: "doc-1",
    name: "Notes",
    mimeType: "application/pdf",
    modifiedTime: "2026-01-02T03:04:05.000Z",
    owners: [{ displayName: "Alice", emailAddress: "alice@example.com", permissionId: "p-alice" }],
    permissions: [
      { type: "user", id: "p-bob", displayName: "Bob", emailAddress: "bob@example.com" },
      { type: "user", id: "p-gone", deleted: true },
    ],
  };
  const facts = driveFileToBatch(file)
    .items.filter((i) => "fact" in i)
    .map((i) => (i as { fact: { predicate: string; valid_from: number } }).fact);
  const personPreds = new Set(["name", "email", "account-deleted"]);
  for (const f of facts) {
    if (personPreds.has(f.predicate)) assert.equal(f.valid_from, 0, `${f.predicate} must be observation-independent`);
    else assert.ok(f.valid_from > 0, `${f.predicate} keeps the file's time`);
  }
  assert.ok(facts.some((f) => f.predicate === "name"));
  assert.ok(facts.some((f) => f.predicate === "account-deleted"));
  assert.ok(facts.some((f) => f.predicate === "doc-name"));
});

test("grantClosures closes exactly the stored grants missing from the incoming set", () => {
  const out = grantClosures(100, new Set([11, 12]), [11, 12, 13, 14], 1_700_000_000);
  assert.deepEqual(out, [
    { close: { subject: 100, predicate: "can-access", object: { node: 13 }, valid_from: 1_700_000_000 } },
    { close: { subject: 100, predicate: "can-access", object: { node: 14 }, valid_from: 1_700_000_000 } },
  ]);
});

test("grantClosures is empty when the ACL and the stored grants agree", () => {
  assert.deepEqual(grantClosures(100, new Set([21, 22]), [22, 21], 1_700_000_000), []);
});

test("grantClosures closes every stored grant when the incoming set is empty", () => {
  const out = grantClosures(200, new Set<number>(), [31, 32, 33], 1_700_000_000);
  assert.deepEqual(out, [
    { close: { subject: 200, predicate: "can-access", object: { node: 31 }, valid_from: 1_700_000_000 } },
    { close: { subject: 200, predicate: "can-access", object: { node: 32 }, valid_from: 1_700_000_000 } },
    { close: { subject: 200, predicate: "can-access", object: { node: 33 }, valid_from: 1_700_000_000 } },
  ]);
});

test("close items serialize to the engine's wire shape (object = the closed element)", () => {
  const [item] = grantClosures(300, new Set<number>(), [42], 1_700_000_001);
  assert.equal(JSON.stringify(item), '{"close":{"subject":300,"predicate":"can-access","object":{"node":42},"valid_from":1700000001}}');
});

test("driveFileToBatch reports the file-time instant its facts carry (the close stamp)", () => {
  const file: DriveFile = { id: "doc-2", name: "Spec", mimeType: "application/pdf", modifiedTime: "2026-01-02T03:04:05.000Z" };
  assert.equal(driveFileToBatch(file).at, Date.parse("2026-01-02T03:04:05.000Z") / 1000);
});

test("hash48 identity is defined over the first 4096 code units", () => {
  const base = "x".repeat(4096);
  assert.equal(hash48(base + "tail"), hash48(base));
  assert.notEqual(hash48("x".repeat(4095) + "a"), hash48("x".repeat(4095) + "b"));
});
