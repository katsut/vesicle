// Run one or more Backlog webhook payloads through the connector.
//
//   pnpm backlog                       # dry-run the two fixtures → print the ingest NDJSON
//   pnpm backlog --ingest              # stream the fixtures into a running stroma-serve
//   pnpm backlog --ingest a.json b.json
//
// With --ingest against a live engine, the two fixtures (created → In Progress a day later) demonstrate
// valid-time: after ingest, the issue's status as-of 2026-07-01 is "Open", as-of now is "In Progress".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { backlogEventToBatch, isoToEpoch, type BacklogWebhook } from "../backlog.ts";
import { Stroma } from "../stroma.ts";
import { toNdjson } from "../etl/sink.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = ["backlog-issue-created.json", "backlog-issue-updated.json"].map((f) =>
  resolve(here, "../../fixtures", f),
);

const args = process.argv.slice(2);
const doIngest = args.includes("--ingest");
const files = args.filter((a) => !a.startsWith("--"));
const paths = files.length ? files : fixtures;

const stroma = doIngest ? new Stroma() : null;
if (stroma) await stroma.ensureAuthed();

for (const p of paths) {
  const ev = JSON.parse(readFileSync(p, "utf8")) as BacklogWebhook;
  const batch = backlogEventToBatch(ev);
  console.log(`\n# ${p}\n# → ${batch.kind}: ${batch.summary} (${batch.factCount} facts)`);
  if (doIngest && stroma) {
    if (!batch.items.length) {
      console.log("  (ignored — nothing to ingest)");
      continue;
    }
    const res = await stroma.ingest(toNdjson(batch.items));
    console.log("  ingested:", JSON.stringify(res));
  } else {
    process.stdout.write(toNdjson(batch.items));
  }
}

// After ingesting both fixtures, show the valid-time payoff: status Open (as-of the create) vs current.
if (doIngest && stroma && !files.length) {
  const issue = 3_000_000_000 + 5001; // Issue node id for content.id 5001
  const asOfCreate = isoToEpoch("2026-07-01T12:00:00Z");
  const past = await stroma.query({ op: "point", subject: issue, predicate: "status", valid_at: asOfCreate });
  const now = await stroma.query({ op: "point", subject: issue, predicate: "status" });
  console.log("\n# valid-time payoff (PROJ-42 status)");
  console.log(`  as-of 2026-07-01: ${JSON.stringify(past.one)}`);
  console.log(`  current:          ${JSON.stringify(now.one)}`);
}
