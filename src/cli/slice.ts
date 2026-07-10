// End-to-end vertical slice (the whole point):
//   real schema → LLM proposes ontology → score vs expert gold → transform rows → ingest into
//   StromaDB → run the staffing payoff query on the REAL ingested graph.
//
// Usage:  pnpm slice            (needs stroma-serve running on :7687; API key or `claude` CLI for the LLM)
//         pnpm slice --dry      (skip ingest; just propose + score + transform, print NDJSON + gaps)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseSchema } from "../schema.ts";
import { proposeMapping } from "../propose.ts";
import { transform } from "../transform.ts";
import { Stroma } from "../stroma.ts";
import { toNdjson } from "../etl/sink.ts";
import { planPayoff, runPayoff } from "../payoff.ts";
import { activeBackend } from "../llm.ts";
import { scoreMapping } from "../score.ts";
import type { Mapping } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "../../../../docs/experiments/b2-kit");

function load<T>(rel: string): T {
  return JSON.parse(readFileSync(resolve(KIT, rel), "utf8")) as T;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const schema = parseSchema(readFileSync(resolve(KIT, "schema.sql"), "utf8"));
  const data = load<Record<string, Array<Record<string, unknown>>>>("sample_data.json");
  const gold = load<Mapping>("gold_mapping.json");

  console.log(`\n▸ 1. Parsed schema: ${schema.tables.length} tables (${schema.tables.filter((t) => t.isJoin).map((t) => t.name).join(", ")} are link tables)`);

  console.log(`\n▸ 2. LLM proposes the ontology  [backend: ${activeBackend()}]`);
  const mapping = await proposeMapping(schema);
  console.log(`   entity_types: ${Object.entries(mapping.entity_types).map(([k, v]) => `${k}→${v}`).join(", ")}`);
  console.log(`   predicates:   ${mapping.predicates.map((p) => p.name).join(", ")}`);

  console.log(`\n▸ 3. Score the proposal vs expert gold`);
  const sc = scoreMapping(schema, data, gold, mapping);
  console.log(`   source_capture: ${(sc.sourceCapture * 100).toFixed(0)}%   critical predicates present: ${sc.criticalPresent ? "yes" : "NO"}`);
  console.log(`   downstream recall@5: ${sc.recall.toFixed(2)}   precision@5: ${sc.precision.toFixed(2)}   type-violations: ${sc.typeViolations}`);

  console.log(`\n▸ 4. Transform rows → StromaDB ingest records`);
  const tr = transform(schema, mapping, data);
  const factCount = tr.items.filter((i) => "fact" in i).length;
  console.log(`   ${factCount} facts, ${Object.values(tr.idMap).reduce((n, m) => n + Object.keys(m).length, 0)} nodes`);
  if (tr.gaps.length) {
    console.log(`   engine gaps (proposed but not yet ingestable):`);
    for (const g of tr.gaps) console.log(`     · ${g.text}`);
  }

  if (dry) {
    console.log(`\n(--dry: skipping ingest)\n`);
    return;
  }

  const db = new Stroma();
  if (!(await db.health())) {
    console.error(`\n✗ stroma-serve not reachable on :7687 — start it, or run with --dry\n`);
    process.exit(1);
  }

  console.log(`\n▸ 5. Ingest into StromaDB`);
  await db.ensureAuthed(); // API token if STROMA_API_TOKEN is set, else session login
  const stats = await db.ingest(toNdjson(tr.items));
  console.log(`   ${JSON.stringify(stats)}`);

  console.log(`\n▸ 6. Payoff query on the REAL ingested graph: staff "ML Recommender"`);
  const plan = planPayoff(mapping);
  if ("error" in plan) {
    console.log(`   cannot run: ${plan.error}`);
    return;
  }
  const projects = data["projects"] ?? [];
  const target = projects.find((r) => String(r.name).includes("ML Recommender"));
  const targetGid = tr.idMap[plan.projectType]?.[String(target?.id)];
  if (targetGid == null) {
    console.log(`   target project not found in graph`);
    return;
  }
  // label map gid → source name
  const label: Record<number, string> = {};
  for (const [table, gtype] of Object.entries(tr.typeOf)) {
    for (const row of data[table] ?? []) {
      const g = tr.idMap[gtype]?.[String(row.id)];
      if (g != null) label[g] = String(row.name ?? row.id);
    }
  }
  const rows = await runPayoff(db, tr, plan, targetGid, (g) => label[g] ?? `#${g}`);
  console.log(`   needs: ${(await db.expand(targetGid, plan.needsPred)).map((g) => label[g]).join(" + ")}`);
  rows.forEach((r, i) =>
    console.log(
      `   ${i === 0 ? "★" : " "} ${i + 1}. ${r.name.padEnd(6)} score ${r.score.toFixed(1)}  = strength ${r.strength} − ${r.busyness}% busy  (${r.skills.join(", ")})`,
    ),
  );
  console.log(`\n✓ end-to-end slice complete: schema → LLM → confirm → facts+props+valid_to → StromaDB → strong-and-available answer\n`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
