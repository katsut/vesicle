// Structured Drive slice: the 3-source convergence + post-authz on access labels.
//
// A Google Drive is not one thing — it holds several source kinds: file/folder metadata and
// permissions (org-info), sharing changes (events), and document bodies (deferred to the unstructured
// on-ramp). This slice ingests the STRUCTURED slice (files carry an ABAC sensitivity label; the ACL
// and sharing events become edges) and demonstrates the claim that matters most for a knowledge base
// called the worst failure to get wrong: **post-authz — a caller sees only what their clearance
// permits; higher-sensitivity files are not leaked.**
//
// Usage: pnpm tsx src/cli/drive-slice.ts   (needs stroma-serve --allow-reset; LLM via API key or CLI)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseSchema } from "../schema.ts";
import { proposeMapping } from "../propose.ts";
import { transform } from "../transform.ts";
import { Stroma } from "../stroma.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../sources/google-drive.json");
type Rows = Record<string, Array<Record<string, unknown>>>;
const SENSITIVITY = ["public", "internal", "confidential"];

async function main() {
  const src = JSON.parse(readFileSync(SRC, "utf8")) as { schema: string; data: Rows };
  const schema = parseSchema(src.schema);
  const data = src.data;

  console.log(`\n▸ 1. Google Drive source · ${schema.tables.length} tables (files carry a sensitivity label)`);
  console.log(`   3 source kinds present: org-info (files/folders/permissions) · events (sharing_events) · [document bodies → unstructured on-ramp, later]`);

  console.log(`\n▸ 2. LLM proposes the ontology`);
  const mapping = await proposeMapping(schema);
  console.log(`   types: ${Object.values(mapping.entity_types).join(", ")}`);
  console.log(`   predicates: ${mapping.predicates.map((p) => p.name).join(", ")}`);

  console.log(`\n▸ 3. Transform → NDJSON (file nodes get ABAC labels from their sensitivity)`);
  const tr = transform(schema, mapping, data);

  const db = new Stroma();
  if (!(await db.health())) {
    console.error(`\n✗ stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}\n`);
    process.exit(1);
  }
  await db.ensureAuthed();
  await db.reset();
  console.log(`\n▸ 4. Ingest into StromaDB`);
  console.log(`   ${JSON.stringify(await db.ingest(tr.ndjson))}`);

  // file gid → {name, label}
  const fileType = mapping.entity_types["files"];
  const files: Array<{ gid: number; name: string; label: number }> = [];
  for (const row of data["files"] ?? []) {
    const gid = tr.idMap[fileType ?? ""]?.[String(row["id"])];
    if (gid != null) files.push({ gid, name: String(row["name"]), label: Number(row["label"]) });
  }

  console.log(`\n▸ 5. post-authz — the same files, seen by three clearances (denied = not leaked):`);
  const principals = [
    { who: "Alice (admin)", mask: 0b111 }, // public + internal + confidential
    { who: "Bob (employee)", mask: 0b011 }, // public + internal
    { who: "Dave (contractor)", mask: 0b001 }, // public only
  ];
  for (const p of principals) {
    const seen: string[] = [];
    const denied: string[] = [];
    for (const f of files) {
      const r = await db.node(f.gid, p.mask);
      (r.denied ? denied : seen).push(`${f.name} [${SENSITIVITY[f.label] ?? f.label}]`);
    }
    console.log(`   ${p.who.padEnd(18)} sees: ${seen.join(", ")}`);
    if (denied.length) console.log(`   ${" ".repeat(18)} denied: ${denied.join(", ")}`);
  }

  console.log(`\n✓ Drive structured slice: files carry sensitivity → post-authz reads exclude what a`);
  console.log(`  clearance can't see (no leak). ACL (file_access) & sharing_events ingested as the`);
  console.log(`  org-info + events sources; document bodies are the deferred unstructured on-ramp.`);
  console.log(`  Note: this maps SENSITIVITY classes to labels; faithful per-file ACL→label mapping is`);
  console.log(`  the next step.\n`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
