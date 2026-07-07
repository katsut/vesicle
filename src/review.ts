// Human review capture — the flywheel's first turn. The engine surfaces a gap; a person decides what it
// means (confirm / waive / data-gap) and that decision is written BACK into the graph as a human-asserted
// fact. Those decisions are both the authoritative overlay on the deterministic verdict AND the labelled
// examples a later model learns from. (Full provenance tiers = stromadb #109; here the human-asserted
// nature is carried by the review predicates themselves.)

import type { Stroma } from "./stroma.ts";

export type Decision = "confirmed" | "waived" | "data-gap";

export interface ReviewRecord {
  issue: number;
  decision: Decision;
  reviewer: string;
  note?: string;
}

/** Review predicates (idempotent to (re)declare — the engine allows re-sending the same def). */
const REVIEW_SCHEMA = [
  `{"pred_def":{"name":"review-decision","cardinality":"one","domain":"Issue","range_value":"text"}}`,
  `{"pred_def":{"name":"reviewed-by","cardinality":"one","domain":"Issue","range_value":"text"}}`,
  `{"pred_def":{"name":"review-note","cardinality":"one","domain":"Issue","range_value":"text"}}`,
].join("\n");

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Persist a human decision on a gap as human-asserted facts on the issue. */
export async function recordReview(stroma: Stroma, r: ReviewRecord): Promise<void> {
  const facts = [
    `{"fact":{"subject":${r.issue},"predicate":"review-decision","object":{"text":"${r.decision}"}}}`,
    `{"fact":{"subject":${r.issue},"predicate":"reviewed-by","object":{"text":"${esc(r.reviewer)}"}}}`,
  ];
  if (r.note) facts.push(`{"fact":{"subject":${r.issue},"predicate":"review-note","object":{"text":"${esc(r.note)}"}}}`);
  await stroma.ingest([REVIEW_SCHEMA, ...facts].join("\n"));
}

/** The human review on an issue, if any (the overlay on the engine verdict). Tolerant of the review
 *  predicates not being registered yet (no reviews recorded) — returns null rather than throwing. */
export async function fetchReview(stroma: Stroma, issue: number): Promise<{ decision: Decision; reviewer: string | null; note: string | null } | null> {
  let decision: Decision | null;
  try {
    decision = (await stroma.pointText(issue, "review-decision")) as Decision | null;
  } catch {
    return null; // predicate not registered yet ⇒ nothing has been reviewed
  }
  if (!decision) return null;
  const [reviewer, note] = await Promise.all([stroma.pointText(issue, "reviewed-by"), stroma.pointText(issue, "review-note")]);
  return { decision, reviewer, note };
}
