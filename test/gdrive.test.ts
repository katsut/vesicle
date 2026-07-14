// Unit tests for the Drive structural lane's deterministic pieces (no network).
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DriveFile } from "../src/gdrive-api.ts";
import { driveFileToBatch, driveRootBatch, nid } from "../src/gdrive.ts";

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
