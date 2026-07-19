// Content-addressed store for the EXACT text the extractor saw — the document leg of the
// claim → passage → document provenance chain. The digest pins identity ("these claims came from
// content sha256:…", recorded as a content-digest fact on the Document node); the stored text is
// what re-extraction reads when the extractor improves, without another trip to the source.
//
// Deliberately a plain directory of immutable files under var/ (git-ignored, same lifecycle as
// config.json): content-addressing makes writes idempotent and collisions a non-concern, and the
// engine stays a claims store — raw bodies do not belong in the graph. v1 stores the TEXT lane
// only; a PDF's bytes stay in the source and its digest still pins which content was extracted.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VAR_DIR } from "./etl/store.ts";

const CAS_DIR = resolve(VAR_DIR, "cas");

/** sha256 hex of the exact content (text digests over its UTF-8 bytes). */
export function digestOf(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Store `text` under its digest; returns the digest. Idempotent — an existing entry is left
 *  untouched (same digest = same bytes by construction). */
export function casPut(text: string): string {
  const digest = digestOf(text);
  mkdirSync(CAS_DIR, { recursive: true });
  const file = join(CAS_DIR, digest);
  if (!existsSync(file)) writeFileSync(file, text, "utf8");
  return digest;
}

/** The stored text for a digest, or null when this deployment never stored it (e.g. a PDF —
 *  digest-only — or a CAS populated on another machine). */
export function casGet(digest: string): string | null {
  // digests are hex by construction; reject anything else so a caller bug can't traverse paths
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  const file = join(CAS_DIR, digest);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
