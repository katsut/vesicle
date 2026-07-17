// Deterministic pattern mining — mined rule candidates from event regularities. One template,
// counted at read time through the existing query ops: "of a group's events (type E), what fraction
// carries predicate P to a small target set S (|S| ≤ 2)". Counts only — no learned scores, NO LLM,
// no new engine machinery, no persisted derived state; a candidate is worth surfacing only when
// "rule + exceptions" describes the events more compactly than the raw list, which the coverage
// threshold approximates. Doc-access targets that reach (nearly) every document in the scan are
// demoted to ONE scope-level candidate before per-folder mining (UBIQUITY_THRESHOLD). A candidate's
// counts are a CURRENT-state snapshot; the stability trace (monthlyPoints/stabilityTrace) re-reads
// the same pattern at monthly as-of points so a reviewer sees interruptions — a restored wobble is
// evidence FOR promotion, an unexplained drift argues for risk. A human promotes each candidate to
// a rule, records it as a risk, or dismisses it (routes/patterns.ts) — the same review idiom as
// src/identities.ts / src/approvals.ts.

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
/** A target covering at least this fraction of ALL scanned documents is scope-ubiquitous: excluded
 *  from per-folder greedy selection and reported once as a single scope-level candidate — "P can
 *  reach everything" is ONE scope statement, not N folder rules. */
export const UBIQUITY_THRESHOLD = 0.9;
/** Monthly as-of sample points per stability trace — at most this many, the window's most recent. */
export const MAX_TRACE_POINTS = 36;
/** Events sliced per stability trace when a group is larger (most recent kept) — every extra event
 *  costs one as-of read PER MONTH, so the cap bounds the whole trace at ~cap×points reads. */
export const TRACE_EVENT_CAP = 300;

/** Same node budget as the approvals scan — the widest existing read-time scan. */
const GRAPH_NODE_BUDGET = 6000;

// --- pure mining (unit-tested) ---------------------------------------------------------------------

/** The shipped instantiations of the template. doc-access-scope is the scope-level demotion of
 *  doc-access: one candidate per ubiquitous person over the whole scan, not per folder. */
export type Template = "issue-assignee" | "comment-author" | "doc-access" | "doc-access-scope";

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

/** One scope-ubiquitous target: its reach over ALL scanned documents, reported once instead of
 *  winning every per-folder pick. Same evidence shape as MinedPattern minus the target set. */
export interface ScopePattern {
  target: number;
  support: number;
  total: number;
  exceptions: number[];
  exceptionsOmitted: number;
  windowFrom: number;
  windowTo: number;
}

/** Demote scope-ubiquitous targets before per-folder mining. Coverage is counted over the union of
 *  all groups' events (each document carries one in-folder edge, so the union never double-counts):
 *  a target on ≥ UBIQUITY_THRESHOLD of them is stripped from every event's target list — the events
 *  themselves stay, so they still count against per-folder coverage — and returned as one
 *  ScopePattern, widest reach first (ties to the smaller id). Fewer than MIN_GROUP_SIZE events in
 *  total is too small a population to call anything ubiquitous. */
export function splitUbiquitousTargets(groups: Map<number, EventObs[]>): { groups: Map<number, EventObs[]>; scope: ScopePattern[] } {
  const all = [...groups.values()].flat();
  if (all.length < MIN_GROUP_SIZE) return { groups, scope: [] };
  const reach = new Map<number, number>();
  for (const e of all) {
    for (const t of new Set(e.targets)) reach.set(t, (reach.get(t) ?? 0) + 1);
  }
  const ubiquitous = [...reach.entries()]
    .filter(([, n]) => n / all.length >= UBIQUITY_THRESHOLD)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (!ubiquitous.length) return { groups, scope: [] };
  const drop = new Set(ubiquitous.map(([t]) => t));
  const times = all.map((e) => e.at).filter((t) => t > 0);
  const windowFrom = times.length ? Math.min(...times) : 0;
  const windowTo = times.length ? Math.max(...times) : 0;
  const scope = ubiquitous.map(([target, support]): ScopePattern => {
    const exceptions = all.filter((e) => !e.targets.includes(target)).map((e) => e.id);
    return {
      target,
      support,
      total: all.length,
      exceptions: exceptions.slice(0, EXCEPTION_CAP),
      exceptionsOmitted: Math.max(0, exceptions.length - EXCEPTION_CAP),
      windowFrom,
      windowTo,
    };
  });
  const filtered = new Map<number, EventObs[]>();
  for (const [group, events] of groups) {
    filtered.set(
      group,
      events.map((e) => (e.targets.some((t) => drop.has(t)) ? { ...e, targets: e.targets.filter((t) => !drop.has(t)) } : e)),
    );
  }
  return { groups: filtered, scope };
}

// --- temporal stability (as-of slices) --------------------------------------------------------------

/** UTC month-start instants covering [from, to], most recent `cap` only. A window too short to
 *  contain a month boundary yields [] — one sample point says nothing about stability. */
export function monthlyPoints(from: number, to: number, cap = MAX_TRACE_POINTS): number[] {
  if (from <= 0 || to < from) return [];
  const monthStart = (k: number): number => Date.UTC(Math.floor(k / 12), k % 12, 1) / 1000;
  const d = new Date(from * 1000);
  let k = d.getUTCFullYear() * 12 + d.getUTCMonth();
  if (monthStart(k) < from) k++; // first month-start at or after `from`
  const points: number[] = [];
  for (; monthStart(k) <= to; k++) points.push(monthStart(k));
  return points.slice(-cap);
}

/** One monthly as-of slice: of the events that had ANY target in effect at `at`, how many named a
 *  target in S, whether S held the month (MIN_COVERAGE), and — when it did not — who actually held
 *  it (the most frequent as-of target, ties to the smaller id). */
export interface StabilitySlice {
  at: number;
  population: number;
  covered: number;
  held: boolean;
  top: number | null;
}

export interface StabilityTrace {
  slices: StabilitySlice[];
  /** months with any population */
  measured: number;
  /** of those, months where S reached MIN_COVERAGE */
  held: number;
}

/** Assemble a trace from per-month as-of target lists — one list per event, mirroring
 *  EventObs.targets: a One-predicate event contributes zero or one value, a Many-predicate event
 *  (a document's as-of grant set) any number, and an event is covered when its list intersects S.
 *  An empty list shrinks the month's denominator instead of counting against coverage — unlike
 *  current-state mining: "not yet existing" and "unassigned/ungranted" are indistinguishable in an
 *  as-of read, and a month before the group existed must not read as a wobble. Months with no
 *  population count in neither `measured` nor `held`. */
export function stabilityTrace(monthly: Array<{ at: number; values: ReadonlyArray<readonly number[]> }>, targets: number[]): StabilityTrace {
  const s = new Set(targets);
  const slices = monthly.map(({ at, values }): StabilitySlice => {
    const present = values.filter((list) => list.length > 0);
    const covered = present.filter((list) => list.some((v) => s.has(v))).length;
    const held = present.length > 0 && covered / present.length >= MIN_COVERAGE;
    let top: number | null = null;
    if (present.length && !held) {
      // the month's actual holder: mode over each event's DISTINCT targets (an event with many
      // grantees still votes once per person), ties to the smaller id
      const freq = new Map<number, number>();
      for (const list of present) {
        for (const v of new Set(list)) freq.set(v, (freq.get(v) ?? 0) + 1);
      }
      for (const [v, n] of freq) {
        if (top == null || n > freq.get(top)! || (n === freq.get(top)! && v < top)) top = v;
      }
    }
    return { at, population: present.length, covered, held, top };
  });
  return {
    slices,
    measured: slices.filter((x) => x.population > 0).length,
    held: slices.filter((x) => x.held).length,
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

/** One pass over the graph: display names plus the three template populations, grouped. The
 *  stability route reuses this to reach a candidate's raw events — candidates themselves only
 *  carry capped exceptions. */
export interface EventScan {
  names: Map<number, string | null>;
  issueGroups: Map<number, EventObs[]>;
  commentGroups: Map<number, EventObs[]>;
  docGroups: Map<number, EventObs[]>;
}

/** Scan the graph into the template populations. One graph read supplies the node ids AND the
 *  display names (the engine's graph view carries each node's display predicate), then each event
 *  pays 1–2 point reads for its group edge and its P target — the same read pattern as the
 *  approvals scan. */
export async function scanEventGroups(db: Stroma): Promise<EventScan> {
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
  return { names, issueGroups, commentGroups, docGroups };
}

/** Mine all template instantiations from a scan — deterministic given the scan. */
export function candidatesFromScan(scan: EventScan): PatternCandidate[] {
  const { names, issueGroups, commentGroups, docGroups } = scan;
  // Scope-ubiquity demotion (doc-access only): a person with grants on (nearly) every scanned
  // document wins the greedy pick for every folder — technically correct, low information. Their
  // reach is emitted ONCE below and they are excluded from per-folder selection, so folder
  // candidates surface the NEXT concentration — the actually folder-specific reach.
  const { groups: folderDocGroups, scope } = splitUbiquitousTargets(docGroups);

  const ref = (id: number): NamedRef => ({ id, name: names.get(id) ?? null });
  const out: PatternCandidate[] = [];
  for (const s of scope) {
    out.push({
      // the person carries the pattern identity — no node represents the scan scope itself
      patternId: patternId("doc-access-scope", s.target, "can-access"),
      template: "doc-access-scope",
      group: ref(s.target),
      predicate: "can-access",
      targets: [ref(s.target)],
      support: s.support,
      total: s.total,
      exceptions: s.exceptions.map(ref),
      exceptionsOmitted: s.exceptionsOmitted,
      windowFrom: s.windowFrom,
      windowTo: s.windowTo,
    });
  }
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
  collect("doc-access", "can-access", folderDocGroups);
  return out;
}

/** Scan the graph and mine all template instantiations. */
export async function findPatternCandidates(db: Stroma): Promise<PatternCandidate[]> {
  return candidatesFromScan(await scanEventGroups(db));
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
