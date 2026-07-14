// Ingest guard: late-arrival repair for out-of-order delivery.
//
// Current-value ("head") reads resolve by write order — the last write wins regardless of the
// event's valid_from. Poll delivery is ordered, but webhook redelivery/parallelism can apply an
// older event after a newer one, leaving a stale value as head. As-of reads are unaffected (they
// resolve by valid_from), so dropping late events would trade history completeness for head
// correctness — instead the late batch is ingested unchanged, and the displaced current winner is
// re-asserted afterwards (same subject/predicate/object/valid_from — or the close, when the head was
// ended: the engine reports the boundary as closed_from) so it regains head by a newer write. The
// in-order path (incoming >= current, or a never-written key) produces zero extra writes.
//
// Reads use the raw Stroma client (reads live outside the Sink interface); the batch and the
// follow-up re-assertions go through sink.ingest with the same pipeline id.

import type { PointRecord, Stroma } from "../stroma.ts";
import type { IngestStats, Sink } from "./sink.ts";
import type { BatchItem, FactObject } from "./types.ts";

/** One head repair: the current winner re-asserted after a late-arriving batch displaced it. The
 *  winner is a value fact (`object` set) or a close (`object` absent — the head was ended and a late
 *  fact must not resurrect it). */
export interface Repair {
  subject: number;
  predicate: string;
  object?: FactObject;
  /** the winner's own valid_from (a value's, or the close boundary), unchanged — the repair only
   *  refreshes write order */
  validFrom: number;
  /** the late batch's valid_from that would otherwise have taken head */
  incomingValidFrom: number;
}

export interface GuardedIngest {
  stats: IngestStats;
  repairs: Repair[];
}

/** Ingest one event's batch with late-arrival repair. The batch is self-contained (its pred_defs
 *  declare its cardinality-one predicates), so the guard needs no schema knowledge of its own. One
 *  point read per one-cardinality (subject, predicate) the batch writes with a valid_from — batches
 *  are one event, so small. */
export async function repairLateArrivals(db: Stroma, sink: Sink, batch: BatchItem[], run: { pipelineId: string }): Promise<GuardedIngest> {
  // cardinality-one predicates declared by this batch
  const onePreds = new Set<string>();
  for (const item of batch) {
    if ("pred_def" in item && item.pred_def.cardinality === "one") onePreds.add(item.pred_def.name);
  }

  // The write that ends up as write-order head per (subject, predicate) — the last one in the batch.
  // Facts and closes on a one-predicate both take head; writes without a valid_from are skipped
  // (nothing to compare against).
  const incoming = new Map<string, { subject: number; predicate: string; validFrom: number; object?: FactObject }>();
  for (const item of batch) {
    const w = "fact" in item ? item.fact : "close" in item ? item.close : null;
    if (!w || w.valid_from == null || !onePreds.has(w.predicate)) continue;
    incoming.set(`${w.subject}|${w.predicate}`, {
      subject: w.subject,
      predicate: w.predicate,
      validFrom: w.valid_from,
      object: "fact" in item ? item.fact.object : undefined,
    });
  }

  // Read the current winners BEFORE the batch lands — afterwards head is already the late value.
  const repairs: Repair[] = [];
  if (incoming.size) await db.ensureAuthed();
  for (const inc of incoming.values()) {
    let cur: PointRecord;
    try {
      cur = await db.pointRecord(inc.subject, inc.predicate);
    } catch (e) {
      // A predicate this batch is about to define is unknown to the engine, so it has no current
      // value to displace. Anything else (auth, network) must surface — silently skipping a read
      // would silently skip a repair.
      if ((e as Error).message.includes("unknown predicate")) continue;
      throw e;
    }
    // The current winner is a live value (valid_from) or a close (closed_from). In-order
    // (incoming >= current) or never-written: nothing to repair.
    const curVf = cur.one ? cur.valid_from : cur.closed_from;
    if (curVf == null || curVf <= inc.validFrom) continue;
    if (cur.one) {
      const object: FactObject | null = cur.one.node != null ? { node: cur.one.node } : cur.one.text != null ? { text: cur.one.text } : null;
      if (!object) continue;
      // An equal-valued row taking write-order head changes nothing any read can observe — no
      // repair. Without this, observation-independent facts (valid_from 0) would fight older
      // stored rows on every re-sync: land, get repaired over, land again next time, forever.
      const sameValue =
        inc.object != null &&
        (("node" in inc.object && "node" in object && inc.object.node === object.node) ||
          ("text" in inc.object && "text" in object && inc.object.text === object.text));
      if (sameValue) continue;
      repairs.push({ subject: inc.subject, predicate: inc.predicate, object, validFrom: curVf, incomingValidFrom: inc.validFrom });
    } else {
      // the head was ended by a newer close — re-assert the close so the late value doesn't resurrect it
      repairs.push({ subject: inc.subject, predicate: inc.predicate, validFrom: curVf, incomingValidFrom: inc.validFrom });
    }
  }

  // Ingest the batch unchanged (history/as-of stays complete), then re-assert the displaced winners
  // as one follow-up batch through the same sink + pipeline id — a value as a fact, an ended head as
  // a close.
  const stats = await sink.ingest(batch, run);
  if (repairs.length) {
    const followUp: BatchItem[] = repairs.map((r) =>
      r.object
        ? { fact: { subject: r.subject, predicate: r.predicate, object: r.object, valid_from: r.validFrom } }
        : { close: { subject: r.subject, predicate: r.predicate, valid_from: r.validFrom } },
    );
    await sink.ingest(followUp, run);
  }
  return { stats, repairs };
}
