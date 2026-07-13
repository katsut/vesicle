// Shared server singletons: the one sink every engine write path uses, the guard reader, and the
// Backlog source. Module-level instances — one per process, imported by the route modules.

import { Stroma } from "./stroma.ts";
import { StromaSink } from "./etl/sink.ts";
import type { Repair } from "./etl/guard.ts";
import { BacklogSource } from "./etl/source.ts";
import { loadConfig } from "./etl/store.ts";

// ETL wiring: one shared sink for every engine write path (webhook ingest, poll ingest, apply); the
// Backlog source normalizes both transports (webhook push + poll pull) into the same batches.
// Read/query paths (payoff expand, conformance, evaluate) keep using the Stroma client directly.
export const sink = new StromaSink(new Stroma(loadConfig().sink.url));
export const guardDb = new Stroma(loadConfig().sink.url); // late-arrival guard reads — reads stay on the raw client
export const backlogSource = new BacklogSource();

export const logRepairs = (pipelineId: string, repairs: Repair[]): void => {
  for (const r of repairs) {
    console.log(`  late-arrival repair (${pipelineId}): re-asserted ${r.object ? "head" : "close"} of ${r.subject} "${r.predicate}" (current valid_from ${r.validFrom} > incoming ${r.incomingValidFrom})`);
  }
};
