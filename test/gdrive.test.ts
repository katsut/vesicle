// Unit tests for the Drive structural lane's deterministic pieces (no network).
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { driveRootBatch, nid } from "../src/gdrive.ts";

test("driveRootBatch names the shared drive's root Folder node", () => {
  const items = driveRootBatch("0Aexample", "Team Drive", 1_700_000_000_000);
  const root = nid("Folder", "0Aexample");
  const node = items.find((i) => "node" in i && i.node.id === root);
  assert.ok(node, "root Folder node present");
  const facts = items.filter((i) => "fact" in i).map((i) => (i as { fact: { subject: number; predicate: string; object: unknown; valid_from: number } }).fact);
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0], { subject: root, predicate: "folder-name", object: { text: "Team Drive" }, valid_from: 1_700_000_000_000 });
});
