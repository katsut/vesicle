// Conformance review: declare a decision-authority rule, have the ENGINE evaluate it deterministically
// (no LLM — a measurement showed an agent is unreliable at this), and turn the raw verdicts into a
// human-reviewable list of gaps. This is the app side of "engine evaluates, human reviews the negative
// knowledge": the MISMATCH (wrong/stale) and ABSENT subjects are the compliance gaps a person confirms
// or corrects (the correction is where the human-in-the-loop provenance/flywheel begins).

import type { EngineVerdict, Stroma } from "./stroma.ts";
import { fetchReview, type Decision } from "./review.ts";

/** A declared conformance rule (mirrors the engine's shape; authored, not composed by an agent). */
export interface Rule {
  subject_type: string;
  scope?: { predicate: string; equals: string };
  required: { hops: Array<{ predicate: string; as_of?: string }> };
  actual: string;
  absent_when?: { predicate: string; equals: string };
}

/** One reviewed subject: the raw verdict plus resolved names, a plain-language explanation, and any
 *  human review that has been recorded on it (the overlay on the deterministic verdict). */
export interface ReviewItem {
  subject: number;
  name: string;
  verdict: EngineVerdict["verdict"];
  kind?: "stale" | "wrong" | null;
  requiredName: string | null;
  actualName: string | null;
  asOf: number | null;
  why: string;
  human?: { decision: Decision; reviewer: string | null; note: string | null }; // present once reviewed
}

export interface Review {
  total: number;
  ok: number;
  notApplicable: number;
  gaps: ReviewItem[]; // ABSENT + MISMATCH, in engine order
  open: number; // gaps not yet reviewed by a human
  resolved: number; // gaps a human has recorded a decision on
}

const NAME_PREDS = ["name", "title", "dept-name", "project-name"];

/** Resolve a node id to a display name (first non-empty of a few text predicates), memoized. */
function nameResolver(stroma: Stroma): (id: number | null | undefined) => Promise<string | null> {
  const cache = new Map<number, string | null>();
  return async (id) => {
    if (id == null) return null;
    if (cache.has(id)) return cache.get(id) ?? null;
    let name: string | null = null;
    for (const p of NAME_PREDS) {
      name = await stroma.pointText(id, p);
      if (name) break;
    }
    cache.set(id, name);
    return name;
  };
}

const label = (name: string | null, id: number | null | undefined): string =>
  name ? `${name} (#${id})` : id == null ? "—" : `#${id}`;

function explain(v: EngineVerdict, subjectName: string, requiredName: string | null, actualName: string | null): string {
  const req = label(requiredName, v.required?.node);
  const act = label(actualName, v.actual?.node);
  switch (v.verdict) {
    case "ABSENT":
      return `no ${"actual"} value present where one is required (required authority: ${req})`;
    case "MISMATCH":
      return v.kind === "stale"
        ? `resolved by ${act}, who held the authority earlier but not as of ${v.as_of} — the current required authority is ${req}`
        : `resolved by ${act}, who is not the required authority ${req}`;
    default:
      return "";
  }
}

/** Evaluate `rule` in the engine and produce a human-reviewable report (names resolved, gaps grouped). */
export async function review(stroma: Stroma, rule: Rule): Promise<Review> {
  const verdicts = await stroma.conformance(rule as unknown as Record<string, unknown>);
  const resolve = nameResolver(stroma);

  let ok = 0;
  let notApplicable = 0;
  const gaps: ReviewItem[] = [];

  for (const v of verdicts) {
    if (v.verdict === "OK") { ok++; continue; }
    if (v.verdict === "NOT_APPLICABLE") { notApplicable++; continue; }
    const [subjectName, requiredName, actualName, human] = await Promise.all([
      resolve(v.subject),
      resolve(v.required?.node),
      resolve(v.actual?.node),
      fetchReview(stroma, v.subject),
    ]);
    gaps.push({
      subject: v.subject,
      name: label(subjectName, v.subject),
      verdict: v.verdict,
      kind: v.kind,
      requiredName,
      actualName,
      asOf: v.as_of ?? null,
      why: explain(v, subjectName ?? "", requiredName, actualName),
      ...(human ? { human } : {}),
    });
  }

  const resolved = gaps.filter((g) => g.human).length;
  return { total: verdicts.length, ok, notApplicable, gaps, open: gaps.length - resolved, resolved };
}
