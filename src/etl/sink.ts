// Sink: where batches go. StromaSink is the only implementation — it wraps the low-level Stroma HTTP
// client and owns the wire format: batch items become NDJSON here and nowhere else in the ETL layer.
//
// `reset` is deliberately NOT on the Sink interface: clearing the database is an admin operation on
// StromaSink (and the raw client), never something a pipeline run does.

import { Stroma } from "../stroma.ts";
import type { BatchItem } from "./types.ts";

/** Engine counters returned by /ingest and /stats — passed through opaquely. */
export type IngestStats = Record<string, unknown>;
export type SinkStats = Record<string, unknown>;

export interface Sink {
  health(): Promise<boolean>;
  ingest(batch: BatchItem[], run: { pipelineId: string }): Promise<IngestStats>;
  stats(): Promise<SinkStats | null>;
}

/** Serialize batch items to the engine's JSONL ingest body ("" for an empty batch). Also used by the
 *  CLIs that drive the low-level client directly. */
export function toNdjson(batch: BatchItem[]): string {
  return batch.length ? batch.map((item) => JSON.stringify(item)).join("\n") + "\n" : "";
}

export class StromaSink implements Sink {
  constructor(private db = new Stroma()) {}

  health(): Promise<boolean> {
    return this.db.health();
  }

  /** One batch → one durable ingest. Facts and closes without provenance are stamped with the pipeline id. */
  async ingest(batch: BatchItem[], run: { pipelineId: string }): Promise<IngestStats> {
    await this.db.ensureAuthed();
    const stamped = batch.map((item) => {
      if ("fact" in item && item.fact.source == null) return { fact: { ...item.fact, source: run.pipelineId } };
      if ("close" in item && item.close.source == null) return { close: { ...item.close, source: run.pipelineId } };
      return item;
    });
    return this.db.ingest(toNdjson(stamped));
  }

  /** Engine counters, or null when the engine is unreachable. */
  async stats(): Promise<SinkStats | null> {
    if (!(await this.db.health())) return null;
    await this.db.ensureAuthed();
    return this.db.stats();
  }

  /** Admin: clear the whole database before a full load (opt-in on the server; see Stroma.reset). */
  async reset(): Promise<void> {
    await this.db.ensureAuthed();
    await this.db.reset();
  }
}
