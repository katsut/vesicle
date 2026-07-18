// Human-decision capture — every review surface's verdict recorded as a structured, append-only
// ReviewRecord node, not just applied to the current graph.
//
// The domain writes stay exactly what they were (a confirmed same-as edge, approved-by facts, a
// MinedRule node, review facts on the subject); what was MISSING is the situation: what was
// proposed, from what evidence, and what the human decided — including the rejections, which
// today vanish into config-store dismissal lists. A dismissal is deliberately NOT a domain fact
// ("a non-rule is not a fact we can assert"), but the DECISION itself is a true fact about the
// review process, so it belongs in the graph as a record — the domain stays clean, the decision
// log stays complete. These records are both ground truth for the current graph and labelled
// examples (positives AND negatives) for improving the proposers over time.
//
// One record per decision instance, never superseded: re-reviewing the same proposal later mints a
// new record (the id keys on surface|proposal-key|instant|reviewer), so the log is append-only by
// construction. Facts carry no inline source — the sink stamps HUMAN_REVIEW_ID, the uniform
// human-asserted provenance for this band.

import type { Sink } from "./etl/sink.ts";
import type { BatchItem } from "./etl/types.ts";
import { hash48 } from "./gdrive.ts";

/** Pipeline id = the provenance stamped on every record fact (the sink fills unset sources). */
export const HUMAN_REVIEW_ID = "human-review";

/** The ReviewRecord id band — one above the pattern-review band (see the band table in gdrive.ts). */
export const REVIEW_BAND = 11 * 2 ** 48;

/** The review surfaces that capture decisions. */
export type ReviewSurface = "identities" | "approvals" | "patterns" | "sharing-conformance" | "decision-conformance" | "wizard" | "inferences";

export interface ReviewRecordInput {
  surface: ReviewSurface;
  /** the proposal's stable key WITHIN the surface (pair "lo-hi", "comment|issue", patternId, node id) */
  key: string;
  /** the surface's own verdict vocabulary — confirmed / dismissed / promote / risk / waived / data-gap … */
  decision: string;
  /** one line: WHAT was proposed (renders as the node's display name) */
  proposal: string;
  /** one line: the evidence that backed the proposal, when the surface can (re)state it */
  evidence?: string;
  reviewer?: string;
  note?: string;
  /** decision instant, epoch seconds */
  at: number;
  /** typed subject pointers — the nodes the proposal was about */
  persons?: readonly number[];
  issues?: readonly number[];
  documents?: readonly number[];
}

/** Record types and predicates (idempotent to (re)declare — rides every batch, like the other
 *  review schemas). Subject pointers are per-range predicates so they stay typed, traversable
 *  edges: "every decision ever made about person P" is one expand, not a value scan. */
const SCHEMA: BatchItem[] = [
  { type_def: { name: "ReviewRecord" } },
  { pred_def: { name: "review-surface", cardinality: "one", domain: "ReviewRecord", range_value: "text" } },
  { pred_def: { name: "review-decision", cardinality: "one", domain: "ReviewRecord", range_value: "text" } },
  { pred_def: { name: "review-proposal", cardinality: "one", domain: "ReviewRecord", range_value: "text", display: true } },
  { pred_def: { name: "review-evidence", cardinality: "one", domain: "ReviewRecord", range_value: "text" } },
  { pred_def: { name: "review-reviewer", cardinality: "one", domain: "ReviewRecord", range_value: "text" } },
  { pred_def: { name: "review-note", cardinality: "one", domain: "ReviewRecord", range_value: "text" } },
  { pred_def: { name: "review-of-person", cardinality: "many", domain: "ReviewRecord", range: "Person" } },
  { pred_def: { name: "review-of-issue", cardinality: "many", domain: "ReviewRecord", range: "Issue" } },
  { pred_def: { name: "review-of-document", cardinality: "many", domain: "ReviewRecord", range: "Document" } },
];

// A record is a compact line, not a dumping ground: request-supplied strings (reviewer, note, and
// through some surfaces the key) are clamped before they reach the hash loop or land as facts —
// which also bounds the id hash's iteration over user-controlled input explicitly, not just via
// the body-size limit.
const KEY_MAX = 200;
const NAME_MAX = 120;
const LINE_MAX = 500;
const clamp = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);

/** Deterministic record id: the decision INSTANCE, not the proposal — the same proposal re-reviewed
 *  later (or by another reviewer) mints a distinct record, so the log never supersedes itself. */
export const reviewRecordId = (surface: ReviewSurface, key: string, at: number, reviewer?: string): number =>
  REVIEW_BAND + hash48(`${surface}|${clamp(key, KEY_MAX)}|${at}|${clamp(reviewer ?? "", NAME_MAX)}`);

/** One decision → a self-contained ingest batch (schema + the record node + its facts). All facts
 *  carry valid_from = the decision instant and no source — the sink stamps HUMAN_REVIEW_ID. */
export function reviewRecordBatch(r: ReviewRecordInput): BatchItem[] {
  const id = reviewRecordId(r.surface, r.key, r.at, r.reviewer);
  const items: BatchItem[] = [...SCHEMA, { node: { id, type: "ReviewRecord" } }];
  const fact = (predicate: string, text: string): void => {
    items.push({ fact: { subject: id, predicate, object: { text }, valid_from: r.at } });
  };
  fact("review-surface", r.surface);
  fact("review-decision", clamp(r.decision, NAME_MAX));
  fact("review-proposal", clamp(r.proposal, LINE_MAX));
  if (r.evidence) fact("review-evidence", clamp(r.evidence, LINE_MAX));
  if (r.reviewer) fact("review-reviewer", clamp(r.reviewer, NAME_MAX));
  if (r.note) fact("review-note", clamp(r.note, LINE_MAX));
  const point = (predicate: string, nodes: readonly number[] | undefined): void => {
    for (const node of nodes ?? []) {
      items.push({ fact: { subject: id, predicate, object: { node }, valid_from: r.at } });
    }
  };
  point("review-of-person", r.persons);
  point("review-of-issue", r.issues);
  point("review-of-document", r.documents);
  return items;
}

/** Write one decision record through the sink (which stamps HUMAN_REVIEW_ID as provenance).
 *  Callers run this AFTER their domain write — a failed record surfaces as the route's error, but
 *  the domain verdict has already landed. */
export async function recordDecision(sink: Sink, r: ReviewRecordInput): Promise<void> {
  await sink.ingest(reviewRecordBatch(r), { pipelineId: HUMAN_REVIEW_ID });
}
