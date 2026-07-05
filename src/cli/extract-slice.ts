// Unstructured on-ramp, end to end:
//   sample documents → [LLM extracts typed facts per the confirmed pattern] → resolve names → NDJSON
//   → ingest into StromaDB → query the cross-document graph.
//
// One extractor serves every document type; the human confirms the
// PATTERN (not each fact); facts converge to the same typed-fact contract as the structured on-ramp;
// each fact is stamped with provenance (derived + source document) via edge properties (stromadb #98),
// stored in the engine and read back. Engine-level asserted/derived distinction with a
// default-to-asserted read filter is stromadb #109 (deferred: it would change the determinism-tested many-edge fold).
//
// Usage: pnpm tsx src/cli/extract-slice.ts   (needs stroma-serve; LLM via API key or `claude` CLI)

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { extractFacts, type ExtractedFact, type Pattern } from "../extract.ts";
import { Stroma } from "../stroma.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = resolve(HERE, "../../docs-sample");

// The confirmed extraction pattern (authored once — the unstructured analogue of the wizard mapping).
const PATTERN: Pattern = {
  entity_types: ["Person", "Team", "Project", "Skill"],
  predicates: [
    { name: "member-of", from: "Person", to: "Team", kind: "edge", card: "many" },
    { name: "reports-to", from: "Person", to: "Person", kind: "edge", card: "one" },
    { name: "has-skill", from: "Person", to: "Skill", kind: "edge", card: "many" },
    { name: "owns", from: "Team", to: "Project", kind: "edge", card: "many" },
    { name: "needs-skill", from: "Project", to: "Skill", kind: "edge", card: "many" },
  ],
};

function nkey(type: string, name: string) {
  return `${type} ${name.trim().toLowerCase()}`; // simple exact-name resolution (真の名寄せ is harder)
}

async function main() {
  const docs = readdirSync(DOCS)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ id: basename(f, ".txt"), text: readFileSync(resolve(DOCS, f), "utf8") }));

  console.log(`\n▸ 1. ${docs.length} documents · confirmed pattern: ${PATTERN.entity_types.join(", ")} + ${PATTERN.predicates.map((p) => p.name).join(", ")}`);

  console.log(`\n▸ 2. Extract typed facts from each document (LLM, one call per doc)`);
  const facts: ExtractedFact[] = [];
  for (const d of docs) {
    const f = await extractFacts(PATTERN, d.id, d.text);
    console.log(`   ${d.id}: ${f.length} facts`);
    facts.push(...f);
  }

  console.log(`\n▸ 3. Resolve entity names → node ids (cross-document merge)`);
  const idOf = new Map<string, number>();
  const labelOf = new Map<number, string>();
  const typeOf = new Map<number, string>();
  let next = 1;
  const resolve1 = (type: string, name: string) => {
    const k = nkey(type, name);
    let id = idOf.get(k);
    if (id == null) {
      id = next++;
      idOf.set(k, id);
      labelOf.set(id, name.trim());
      typeOf.set(id, type);
    }
    return id;
  };
  const valuePreds = new Set(PATTERN.predicates.filter((p) => p.kind === "value").map((p) => p.name));
  for (const f of facts) {
    resolve1(f.subjectType || "Person", f.subject);
    if (!valuePreds.has(f.predicate) && f.objectType) resolve1(f.objectType, f.object);
  }
  console.log(`   ${idOf.size} distinct entities across ${docs.length} docs`);

  // NDJSON: type_defs, pred_defs, nodes, facts. (Provenance: see the finding below.)
  const lines: string[] = [];
  for (const t of PATTERN.entity_types) lines.push(JSON.stringify({ type_def: { name: t } }));
  for (const p of PATTERN.predicates) {
    lines.push(JSON.stringify({
      pred_def: p.kind === "value"
        ? { name: p.name, cardinality: p.card, domain: p.from, range_value: "text" }
        : { name: p.name, cardinality: p.card, domain: p.from, range: p.to },
    }));
  }
  for (const [id, name] of labelOf) lines.push(JSON.stringify({ node: { id, type: typeOf.get(id), name } }));
  // Provenance rides the fact as reserved edge properties (stromadb #98): every extracted fact is
  // stamped derived + its source document, stored in the engine and read back below. (Engine-level
  // asserted/derived distinction with a default-to-asserted read filter = stromadb #109, deferred:
  // first-class provenance on many-edges would change the determinism-tested many-edge fold.)
  const prov = { "@derived": true, "@source": "" };
  for (const f of facts) {
    const subj = idOf.get(nkey(f.subjectType || "Person", f.subject));
    if (subj == null) continue;
    const props = { ...prov, "@source": `doc:${f.source}` };
    if (valuePreds.has(f.predicate) || !f.objectType) {
      lines.push(JSON.stringify({ fact: { subject: subj, predicate: f.predicate, object: { text: f.object }, props } }));
    } else {
      const obj = idOf.get(nkey(f.objectType, f.object));
      if (obj == null) continue;
      lines.push(JSON.stringify({ fact: { subject: subj, predicate: f.predicate, object: { node: obj }, props } }));
    }
  }

  const db = new Stroma();
  if (!(await db.health())) {
    console.error(`\n✗ stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}\n`);
    process.exit(1);
  }
  await db.ensureAuthed();
  await db.reset();
  console.log(`\n▸ 4. Ingest extracted facts into StromaDB`);
  const stats = await db.ingest(lines.join("\n") + "\n");
  console.log(`   ${JSON.stringify(stats)}`);

  console.log(`\n▸ 5. Query the cross-document knowledge graph`);
  const nameToId = (type: string, name: string) => idOf.get(nkey(type, name));
  const show = async (label: string, subject: number | undefined, pred: string) => {
    if (subject == null) return console.log(`   ${label}: (entity not found)`);
    const ids = await db.expand(subject, pred);
    console.log(`   ${label}: ${ids.map((i) => labelOf.get(i) ?? `#${i}`).join(", ") || "(none)"}`);
  };
  await show("Alice's skills", nameToId("Person", "Alice"), "has-skill");
  await show("Carol's skills", nameToId("Person", "Carol"), "has-skill");
  await show("Who reports to Alice? (via Carol) — Carol reports-to", nameToId("Person", "Carol"), "reports-to");
  await show("Platform team owns", nameToId("Team", "Platform"), "owns");
  await show("ML Recommender needs", nameToId("Project", "ML Recommender"), "needs-skill");

  console.log(`\n▸ 6. Provenance read back from StromaDB (derived + source document per fact):`);
  const provOf = async (subj: number | undefined, pred: string, obj: number | undefined) => {
    if (subj == null || obj == null) return;
    const p = await db.edgeProps(subj, pred, obj);
    if (p["@source"] != null) {
      console.log(`   ${labelOf.get(subj)} —${pred}→ ${labelOf.get(obj)}   derived=${p["@derived"]} · ${p["@source"]}`);
    }
  };
  await provOf(nameToId("Person", "Alice"), "has-skill", nameToId("Skill", "Python"));
  await provOf(nameToId("Person", "Alice"), "has-skill", nameToId("Skill", "ML"));
  await provOf(nameToId("Person", "Carol"), "reports-to", nameToId("Person", "Alice"));
  await provOf(nameToId("Person", "Bob"), "member-of", nameToId("Team", "Platform team"));
  console.log(`\n   Every extracted fact is stamped derived + its source document — so a caller can tell`);
  console.log(`   extraction-derived facts from asserted ones and trace them back. (Engine-level`);
  console.log(`   default-to-asserted read filter = stromadb #109, deferred.)`);
  console.log(`\n✓ unstructured on-ramp: docs → LLM extract → typed facts (+provenance) → StromaDB → graph\n`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
