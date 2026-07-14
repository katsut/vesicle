// Deterministic pattern mining — mined rule candidates from event regularities. One template,
// counted at read time through the existing query ops: "of a group's events (type E), what fraction
// carries predicate P to a small target set S (|S| ≤ 2)". Counts only — no learned scores, NO LLM,
// no new engine machinery, no persisted derived state; a candidate is worth surfacing only when
// "rule + exceptions" describes the events more compactly than the raw list, which the coverage
// threshold approximates. A human promotes each candidate to a rule, records it as a risk, or
// dismisses it (routes/patterns.ts) — the same review idiom as src/identities.ts / src/approvals.ts.

import type { Stroma } from "./stroma.ts";
import type { BatchItem } from "./etl/types.ts";
import { hash48, nid } from "./gdrive.ts";

// --- candidate thresholds (all deterministic, all named here) --------------------------------------

/** Groups with fewer events than this never yield a candidate — too few observations to call a rule. */
export const MIN_GROUP_SIZE = 10;
/** S must cover at least this fraction of the group's events. */
export const MIN_COVERAGE = 0.8;
/** |S| ≤ 2 — a regularity spread over more targets is not a rule worth proposing. */
export const MAX_TARGETS = 2;
/** Exceptions listed per candidate; anything beyond is reported as a count, never silently dropped. */
export const EXCEPTION_CAP = 20;

/** Same node budget as the approvals scan — the widest existing read-time scan. */
const GRAPH_NODE_BUDGET = 6000;

// --- pure mining (unit-tested) ---------------------------------------------------------------------

/** The three shipped instantiations of the template. */
export type Template = "issue-assignee" | "comment-author" | "doc-access";

/** One observed event: the P targets it carries (empty = the event lacks P and can only be an
 *  exception) and its event time (epoch seconds, 0 when unreported). */
export interface EventObs {
  id: number;
  targets: number[];
  at: number;
}

/** The mined regularity of one group, before display names are attached. */
export interface MinedPattern {
  /** the target set S, in greedy pick order */
  targets: number[];
  /** events covered by S */
  support: number;
  /** all events in the group */
  total: number;
  /** uncovered event ids, input order, capped at EXCEPTION_CAP */
  exceptions: number[];
  /** how many exceptions were cut beyond the cap */
  exceptionsOmitted: number;
  /** observation window: min/max event time over the group's timestamped events (0 when none) */
  windowFrom: number;
  windowTo: number;
}

/** Mine one group's events. Greedy set cover with at most MAX_TARGETS targets: each step picks the
 *  target covering the most still-uncovered events (ties break to the smaller id, so the result is
 *  deterministic) and stops as soon as coverage reaches MIN_COVERAGE — one target that suffices is
 *  never padded to two. Null when the group is too small or no ≤2-target set reaches coverage. */
export function minePattern(events: EventObs[]): MinedPattern | null {
  if (events.length < MIN_GROUP_SIZE) return null;
  const chosen: number[] = [];
  const covered = new Set<number>();
  for (let step = 0; step < MAX_TARGETS; step++) {
    const gain = new Map<number, number>();
    for (const e of events) {
      if (covered.has(e.id)) continue;
      for (const t of new Set(e.targets)) gain.set(t, (gain.get(t) ?? 0) + 1);
    }
    let best: number | null = null;
    let bestGain = 0;
    for (const [t, g] of gain) {
      if (g > bestGain || (g === bestGain && best != null && t < best)) {
        best = t;
        bestGain = g;
      }
    }
    if (best == null) break; // no uncovered event carries any target
    chosen.push(best);
    for (const e of events) {
      if (e.targets.includes(best)) covered.add(e.id);
    }
    if (covered.size / events.length >= MIN_COVERAGE) break;
  }
  if (!chosen.length || covered.size / events.length < MIN_COVERAGE) return null;
  const exceptions = events.filter((e) => !covered.has(e.id)).map((e) => e.id);
  const times = events.map((e) => e.at).filter((t) => t > 0);
  return {
    targets: chosen,
    support: covered.size,
    total: events.length,
    exceptions: exceptions.slice(0, EXCEPTION_CAP),
    exceptionsOmitted: Math.max(0, exceptions.length - EXCEPTION_CAP),
    windowFrom: times.length ? Math.min(...times) : 0,
    windowTo: times.length ? Math.max(...times) : 0,
  };
}

/** Stable candidate identity: (template, group, predicate) hashed the same way as the Drive node
 *  ids (FNV-1a 48). The id deliberately excludes S and the counts, so re-scans and dismissals keep
 *  referring to the same pattern even as its leading targets shift. */
export function patternId(template: Template, group: number, predicate: string): string {
  return `p${hash48(`${template}|${group}|${predicate}`).toString(16)}`;
}

// --- graph scan ------------------------------------------------------------------------------------

/** A node reference with its display name from the graph view (null when the node has none). */
export interface NamedRef {
  id: number;
  name: string | null;
}

/** One reviewable candidate as the API serves it: the mined counts plus display context. */
export interface PatternCandidate {
  patternId: string;
  template: Template;
  group: NamedRef;
  predicate: string;
  targets: NamedRef[];
  support: number;
  total: number;
  exceptions: NamedRef[];
  exceptionsOmitted: number;
  windowFrom: number;
  windowTo: number;
}

// Event/group id bands, mirrored from the connectors that mint them (src/backlog.ts BASE,
// src/gdrive.ts BAND) — each band holds exactly one type, so an id check replaces a node read.
const ISSUE_LO = 3_000_000_000_000;
const ISSUE_HI = 4_000_000_000_000;
const COMMENT_LO = 4_000_000_000_000;
const COMMENT_HI = 5_000_000_000_000;
const DOCUMENT_LO = 5 * 2 ** 48;
const DOCUMENT_HI = 6 * 2 ** 48;

/** The document's current can-access grantees. The predicate not existing yet (no Drive ACL data
 *  anywhere) is a normal state, not an error. */
async function canAccess(db: Stroma, doc: number): Promise<number[]> {
  try {
    return await db.expand(doc, "can-access");
  } catch (e) {
    if ((e as Error).message.includes("unknown predicate")) return [];
    throw e;
  }
}

/** Scan the graph and mine all three template instantiations. One graph read supplies the node ids
 *  AND the display names (the engine's graph view carries each node's display predicate), then each
 *  event pays 1–2 point reads for its group edge and its P target — the same read pattern as the
 *  approvals scan. */
export async function findPatternCandidates(db: Stroma): Promise<PatternCandidate[]> {
  await db.ensureAuthed();
  const g = await db.query({ op: "graph", max_nodes: GRAPH_NODE_BUDGET });
  const nodes = (g.nodes as Array<{ id: number; name?: string }>) ?? [];
  const names = new Map<number, string | null>();
  for (const n of nodes) names.set(n.id, n.name ?? null);

  const issueGroups = new Map<number, EventObs[]>(); // project → issue events
  const commentGroups = new Map<number, EventObs[]>(); // project → comment events
  const docGroups = new Map<number, EventObs[]>(); // folder → document events
  const projectOf = new Map<number, number | null>(); // issue → in-project cache (comment lane)

  const push = (groups: Map<number, EventObs[]>, group: number, e: EventObs): void => {
    const list = groups.get(group);
    if (list) list.push(e);
    else groups.set(group, [e]);
  };

  for (const n of nodes) {
    if (n.id >= ISSUE_LO && n.id < ISSUE_HI) {
      // (a) of a project's issues, the share assigned to S — an unassigned issue counts against
      // coverage (it breaks "issues here go to S") rather than shrinking the denominator.
      const project = await db.point(n.id, "in-project");
      if (project == null) continue; // ungrouped — no population to count it in
      const rec = await db.pointRecord(n.id, "assigned-to");
      push(issueGroups, project, { id: n.id, targets: rec.one?.node != null ? [rec.one.node] : [], at: rec.valid_from ?? 0 });
    } else if (n.id >= COMMENT_LO && n.id < COMMENT_HI) {
      // (b) of a project's comments (via on-issue → in-project), the share written by S.
      const issue = await db.point(n.id, "on-issue");
      if (issue == null) continue;
      let project: number | null;
      if (projectOf.has(issue)) {
        project = projectOf.get(issue) ?? null;
      } else {
        project = await db.point(issue, "in-project");
        projectOf.set(issue, project);
      }
      if (project == null) continue;
      const rec = await db.pointRecord(n.id, "commented-by");
      push(commentGroups, project, { id: n.id, targets: rec.one?.node != null ? [rec.one.node] : [], at: rec.valid_from ?? 0 });
    } else if (n.id >= DOCUMENT_LO && n.id < DOCUMENT_HI) {
      // (c) of a folder's documents, the share that someone in S can access — counted per DOCUMENT
      // (covered when any member of S holds a can-access grant on it), NOT per grant, so the number
      // reads as "S can reach support of total documents here" in an audit.
      const rec = await db.pointRecord(n.id, "in-folder");
      const folder = rec.one?.node;
      if (folder == null) continue;
      push(docGroups, folder, { id: n.id, targets: await canAccess(db, n.id), at: rec.valid_from ?? 0 });
    }
  }

  const ref = (id: number): NamedRef => ({ id, name: names.get(id) ?? null });
  const out: PatternCandidate[] = [];
  const collect = (template: Template, predicate: string, groups: Map<number, EventObs[]>): void => {
    for (const [group, events] of groups) {
      const m = minePattern(events);
      if (!m) continue;
      out.push({
        patternId: patternId(template, group, predicate),
        template,
        group: ref(group),
        predicate,
        targets: m.targets.map(ref),
        support: m.support,
        total: m.total,
        exceptions: m.exceptions.map(ref),
        exceptionsOmitted: m.exceptionsOmitted,
        windowFrom: m.windowFrom,
        windowTo: m.windowTo,
      });
    }
  };
  collect("issue-assignee", "assigned-to", issueGroups);
  collect("comment-author", "commented-by", commentGroups);
  collect("doc-access", "can-access", docGroups);
  return out;
}

// --- verdict persistence ---------------------------------------------------------------------------

/** Provenance value / pipeline id stamped on every promoted or risk-recorded fact. */
export const PATTERN_REVIEW_ID = "pattern-review";

/** Pattern-review types and predicates (idempotent to (re)declare). MinedRule carries a promoted
 *  regularity, RiskNote the same counts recorded as a concern; both keep the evidence queryable
 *  (support/total) and point at the counted people (rule-target / risk-target, many). */
const PATTERN_SCHEMA: BatchItem[] = [
  { type_def: { name: "MinedRule" } },
  { type_def: { name: "RiskNote" } },
  { pred_def: { name: "rule-title", cardinality: "one", domain: "MinedRule", range_value: "text", display: true } },
  { pred_def: { name: "rule-support", cardinality: "one", domain: "MinedRule", range_value: "int" } },
  { pred_def: { name: "rule-total", cardinality: "one", domain: "MinedRule", range_value: "int" } },
  { pred_def: { name: "rule-target", cardinality: "many", domain: "MinedRule", range: "Person" } },
  { pred_def: { name: "risk-title", cardinality: "one", domain: "RiskNote", range_value: "text", display: true } },
  { pred_def: { name: "risk-support", cardinality: "one", domain: "RiskNote", range_value: "int" } },
  { pred_def: { name: "risk-total", cardinality: "one", domain: "RiskNote", range_value: "int" } },
  { pred_def: { name: "risk-target", cardinality: "many", domain: "RiskNote", range: "Person" } },
];

/** The graph record for a human verdict: a MinedRule (promote) or RiskNote (risk) node in the
 *  pattern band, keyed by the verdict-qualified patternId — promoting AND risk-recording the same
 *  pattern yields two distinct nodes. Every fact's valid_from is the observation window's max: the
 *  rule is asserted as of the last evidence event, and a re-promotion after more events supersedes
 *  it with valid time. Facts carry no source — the sink stamps PATTERN_REVIEW_ID. */
export function verdictBatch(c: PatternCandidate, verdict: "promote" | "risk"): BatchItem[] {
  const p = verdict === "promote" ? "rule" : "risk";
  const id = nid("Pattern", `${p}:${c.patternId}`);
  const at = c.windowTo;
  const title = `${c.group.name ?? c.group.id}: ${c.predicate} → ${c.targets.map((t) => t.name ?? t.id).join(", ")} (${c.support}/${c.total})`;
  const items: BatchItem[] = [
    ...PATTERN_SCHEMA,
    { node: { id, type: verdict === "promote" ? "MinedRule" : "RiskNote" } },
    { fact: { subject: id, predicate: `${p}-title`, object: { text: title }, valid_from: at } },
    { fact: { subject: id, predicate: `${p}-support`, object: { int: c.support }, valid_from: at } },
    { fact: { subject: id, predicate: `${p}-total`, object: { int: c.total }, valid_from: at } },
  ];
  for (const t of c.targets) {
    items.push({ fact: { subject: id, predicate: `${p}-target`, object: { node: t.id }, valid_from: at } });
  }
  return items;
}
