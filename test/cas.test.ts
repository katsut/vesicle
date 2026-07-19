// Unit tests for the passage CAS (src/cas.ts): digest stability, put/get round-trip, idempotent
// writes, and the digest-shape guard. The store roots under VESICLE_VAR_DIR, which must be set
// BEFORE the module loads (VAR_DIR resolves at import), hence the dynamic import.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "vesicle-cas-"));
process.env.VESICLE_VAR_DIR = dir;
const { casGet, casPut, digestOf } = await import("../src/cas.ts");

test("digestOf: stable sha256 hex over text and bytes", () => {
  const d = digestOf("Rule 1 applies to everyone.");
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(digestOf("Rule 1 applies to everyone."), d);
  assert.notEqual(digestOf("Rule 2"), d);
  assert.equal(digestOf(Buffer.from("Rule 1 applies to everyone.", "utf8")), d); // text digests over UTF-8 bytes
});

test("casPut/casGet: round-trip under the digest, idempotent re-put", () => {
  const text = "Section 9\nRule 4.2: expenses over the threshold need approval.";
  const digest = casPut(text);
  assert.equal(digest, digestOf(text));
  assert.equal(casGet(digest), text);
  // re-put leaves the entry untouched (same digest = same bytes by construction)
  const before = statSync(join(dir, "cas", digest)).mtimeMs;
  assert.equal(casPut(text), digest);
  assert.equal(statSync(join(dir, "cas", digest)).mtimeMs, before);
});

test("casGet: unknown digests and non-digest strings read as null, never as paths", () => {
  assert.equal(casGet("f".repeat(64)), null); // valid shape, never stored
  assert.equal(casGet("../config.json"), null); // shape guard — no traversal
  assert.equal(casGet("short"), null);
});

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});
