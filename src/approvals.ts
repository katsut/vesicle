// Deterministic approval detection — the review flywheel on decision authority. Approvals live in
// comment prose ("承認します", "LGTM", or just "問題ありません"), not in structured fields, and the
// phrasing is formulaic, so candidate generation is a token-zero pattern scan over Comment content —
// NO LLM anywhere on this path. Each hit + the comment's existing commented-by / on-issue edges
// yields "person P approved issue I at comment time T" with the matched snippet as evidence; a human
// confirms or dismisses each candidate, and a confirmed approval is asserted as approved-by /
// approved-at facts on the issue plus review facts — the same review idiom as src/identities.ts.

import type { Stroma } from "./stroma.ts";
import { personBand, type Band } from "./identities.ts";

// Backlog Issue/Comment id bands (src/backlog.ts BASE) — each band holds one type, so an id check
// suffices; no node-detail read is needed to know the type.
const ISSUE_LO = 3_000_000_000_000;
const ISSUE_HI = 4_000_000_000_000;
const COMMENT_LO = 4_000_000_000_000;
const COMMENT_HI = 5_000_000_000_000;

/** Evidence strength: `formal` = an explicit approval phrase; `euphemism` = the polite go-ahead
 *  vocabulary approvals actually hide in ("問題ありません", "進めてください"). Both need the same
 *  human confirmation — the tier only tells the reviewer how much the phrasing itself asserts. */
export type Tier = "formal" | "euphemism";

/** Default approval phrases, by evidence tier. Non-ASCII patterns (the Japanese sets) match as
 *  plain substrings — Japanese has no word delimiters to anchor on; ASCII patterns match with word
 *  boundaries and case-insensitively, so "approve" hits neither "disapprove" nor "approvedly".
 *  Checked in order, formal tier first — a formal hit wins over any euphemism. */
export const APPROVAL_PATTERNS: Record<Tier, string[]> = {
  formal: [
    "承認します",
    "承認いたします",
    "承認しました",
    "承認です",
    "LGTM",
    "approve",
    "approved",
    "approval granted",
  ],
  euphemism: [
    "問題ありません",
    "問題ないです",
    "大丈夫です",
    "OKです",
    "異議ありません",
    "進めてください",
    "進めていただいて",
  ],
};

/** ±chars of context kept around a hit — enough to judge the phrase without reading the comment. */
const SNIPPET_RADIUS = 40;

const isAscii = (p: string): boolean => /^[\x20-\x7e]+$/.test(p);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Guards (both tiers): a hit whose own sentence is a question ("承認しますか", "can you approve
// this?"), or is preceded in-sentence by a negation ("not approved") or a conditional
// ("修正いただければ承認します" — an approval promised, not given), is not an approval. か(?!ら)
// keeps "〜しますから" (a reason, not a question) matchable.
const QUESTION_AFTER = /^(?:か(?!ら)|[^。.!！\n]*[?？])/;
const NEGATION_OR_CONDITIONAL_BEFORE =
  /(?:\b(?:not|never|cannot|can'?t|don'?t|doesn'?t|didn'?t|won'?t|isn'?t|wouldn'?t|shouldn'?t|unless|if)\b|なければ|れば|たら|ならば|なら)[^。.!?！？\n]*$/i;

const guarded = (text: string, idx: number, len: number): boolean =>
  QUESTION_AFTER.test(text.slice(idx + len)) || NEGATION_OR_CONDITIONAL_BEFORE.test(text.slice(0, idx));

/** The first occurrence of `pattern` that survives the guards — a guarded occurrence does not veto
 *  a later clean one ("大丈夫ですか？はい、大丈夫です。" still hits). */
function findUnguarded(text: string, pattern: string): { idx: number; len: number } | null {
  if (isAscii(pattern)) {
    const re = new RegExp(`\\b${escapeRe(pattern)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      if (!guarded(text, m.index, m[0].length)) return { idx: m.index, len: m[0].length };
    }
    return null;
  }
  let from = 0;
  let idx: number;
  while ((idx = text.indexOf(pattern, from)) >= 0) {
    if (!guarded(text, idx, pattern.length)) return { idx, len: pattern.length };
    from = idx + 1;
  }
  return null;
}

export interface ApprovalMatch {
  tier: Tier;
  pattern: string;
  /** ±SNIPPET_RADIUS chars around the hit, for the evidence display */
  snippet: string;
}

/** Pure pattern scan (unit-tested): the first pattern that hits and survives the guards, formal
 *  tier before euphemism. Null when nothing matches. */
export function matchApproval(text: string, patterns: Record<Tier, string[]> = APPROVAL_PATTERNS): ApprovalMatch | null {
  for (const tier of ["formal", "euphemism"] as const) {
    for (const pattern of patterns[tier]) {
      const hit = findUnguarded(text, pattern);
      if (!hit) continue;
      const snippet = text.slice(Math.max(0, hit.idx - SNIPPET_RADIUS), Math.min(text.length, hit.idx + hit.len + SNIPPET_RADIUS));
      return { tier, pattern, snippet };
    }
  }
  return null;
}

/** One approval candidate: comment C by approver P on issue I, matched at comment time `at`.
 *  issueKey/summary/approverName are display context; `dismissed` is filled from the config store
 *  by the route (a non-approval is not a graph fact, so dismissals don't live in the engine). */
export interface Candidate {
  comment: number;
  issue: number;
  issueKey: string | null;
  summary: string | null;
  approver: number;
  approverName: string | null;
  /** epoch seconds — the content fact's valid_from IS the comment's event time (0 when unreported) */
  at: number;
  snippet: string;
  pattern: string;
  tier: Tier;
  confirmed: boolean;
  dismissed: boolean;
}

/** The issue's current approved-by, or null. Tolerant of the predicate not being declared yet
 *  (nothing confirmed anywhere) — that is a normal state, not an error. */
async function approvedBy(db: Stroma, issue: number, cache: Map<number, number | null>): Promise<number | null> {
  if (cache.has(issue)) return cache.get(issue) ?? null;
  let who: number | null;
  try {
    who = await db.point(issue, "approved-by");
  } catch (e) {
    if (!(e as Error).message.includes("unknown predicate")) throw e;
    who = null;
  }
  cache.set(issue, who);
  return who;
}

/** Scan the graph for Comment nodes and generate approval candidates, each annotated with its
 *  confirmed state (the issue's current approved-by equals this approver). Comments outnumber
 *  persons, so the node budget is wider than the identities scan; only ids in the Comment band get
 *  a content read, and only pattern hits pay for the display lookups. Candidates whose on-issue or
 *  commented-by edge is missing are skipped — there is nothing to confirm onto. */
export async function findApprovalCandidates(db: Stroma): Promise<Candidate[]> {
  await db.ensureAuthed();
  const g = await db.query({ op: "graph", max_nodes: 6000 });
  const nodes = (g.nodes as Array<{ id: number }>) ?? [];
  const out: Candidate[] = [];
  const cache = new Map<number, number | null>();
  for (const n of nodes) {
    if (n.id < COMMENT_LO || n.id >= COMMENT_HI) continue; // not a Comment — no read needed
    const content = await db.pointRecord(n.id, "content");
    const text = content.one?.text;
    if (text == null) continue;
    const hit = matchApproval(text);
    if (!hit) continue;
    const issue = await db.point(n.id, "on-issue");
    const approver = await db.point(n.id, "commented-by");
    if (issue == null || approver == null) continue;
    out.push({
      comment: n.id,
      issue,
      issueKey: await db.pointText(issue, "issue-key"),
      summary: await db.pointText(issue, "summary"),
      approver,
      approverName: await db.pointText(approver, "name"),
      at: content.valid_from ?? 0,
      snippet: hit.snippet,
      pattern: hit.pattern,
      tier: hit.tier,
      confirmed: (await approvedBy(db, issue, cache)) === approver,
      dismissed: false,
    });
  }
  return out;
}

/** What the graph already knows about an approver, carried on the candidate card. Counts are
 *  activity observed in the scanned graph window; a field is omitted (never reported as 0) when
 *  nothing was observed — the scan is budgeted, so "not seen" is absence of evidence, not a fact.
 *  linkedAccounts are the approver's confirmed same-as identities, preformatted for display. */
export interface ApproverContext {
  comments?: number;
  issuesAssigned?: number;
  issuesCreated?: number;
  linkedAccounts?: string[];
  // role: deferred until an organization-structure source exists
}

/** One activity edge observed in the scan: an Issue's assignee/creator or a Comment's author. */
export type ActivityKind = "comment" | "issue-assigned" | "issue-created";

export interface ActivityObs {
  kind: ActivityKind;
  person: number;
}

/** A confirmed same-as neighbour, before display formatting. */
export interface LinkedAccount {
  id: number;
  name: string | null;
}

const BAND_LABEL: Record<Band, string> = { hr: "HR", backlog: "Backlog", drive: "Drive" };

/** "Jane Doe (Drive)" — the neighbour's display name (its id when unnamed) plus its source family. */
export function linkedAccountLabel(acct: LinkedAccount): string {
  const band = personBand(acct.id);
  const name = acct.name ?? String(acct.id);
  return band ? `${name} (${BAND_LABEL[band]})` : name;
}

/** Pure aggregation (unit-tested): fold scan observations into per-approver context. Observations
 *  for persons outside `approvers` are dropped; zero counts and empty linked lists are omitted; an
 *  approver with no context at all gets no map entry. */
export function aggregateApproverContext(
  approvers: Iterable<number>,
  activity: Iterable<ActivityObs>,
  linked: ReadonlyMap<number, LinkedAccount[]>,
): Map<number, ApproverContext> {
  const want = new Set(approvers);
  const counts = new Map<number, Record<ActivityKind, number>>();
  for (const obs of activity) {
    if (!want.has(obs.person)) continue;
    const c = counts.get(obs.person) ?? { comment: 0, "issue-assigned": 0, "issue-created": 0 };
    c[obs.kind]++;
    counts.set(obs.person, c);
  }
  const out = new Map<number, ApproverContext>();
  for (const id of want) {
    const c = counts.get(id);
    const ctx: ApproverContext = {};
    if (c?.comment) ctx.comments = c.comment;
    if (c?.["issue-assigned"]) ctx.issuesAssigned = c["issue-assigned"];
    if (c?.["issue-created"]) ctx.issuesCreated = c["issue-created"];
    const accounts = linked.get(id) ?? [];
    if (accounts.length) ctx.linkedAccounts = accounts.map(linkedAccountLabel);
    if (Object.keys(ctx).length) out.set(id, ctx);
  }
  return out;
}

/** The approver's confirmed same-as neighbours — a same-as edge is only ever written by a human
 *  identity review (src/identities.ts), so edge presence IS confirmation. The predicate not being
 *  declared yet (nothing confirmed anywhere) is a normal state, not an error. */
async function sameAsNeighbours(db: Stroma, id: number): Promise<number[]> {
  try {
    return await db.expand(id, "same-as");
  } catch (e) {
    if (!(e as Error).message.includes("unknown predicate")) throw e;
    return [];
  }
}

/** Context for every approver in one budgeted graph scan. The activity predicates all point AT the
 *  person (Issue→assigned-to/created-by, Comment→commented-by) and expand only walks forward, so
 *  per-approver reads cannot count them; instead one scan reads each Issue's and each Comment's
 *  person edges once and aggregates for the whole candidate list — never N expands per candidate.
 *  same-as IS forward-readable (symmetric), so linked accounts cost one expand per approver. */
export async function approverContexts(db: Stroma, approvers: ReadonlySet<number>): Promise<Map<number, ApproverContext>> {
  if (!approvers.size) return new Map();
  await db.ensureAuthed();
  const g = await db.query({ op: "graph", max_nodes: 6000 });
  const nodes = (g.nodes as Array<{ id: number }>) ?? [];
  const activity: ActivityObs[] = [];
  const push = (kind: ActivityKind, person: number | null): void => {
    if (person != null && approvers.has(person)) activity.push({ kind, person });
  };
  for (const n of nodes) {
    if (n.id >= ISSUE_LO && n.id < ISSUE_HI) {
      push("issue-assigned", await db.point(n.id, "assigned-to"));
      push("issue-created", await db.point(n.id, "created-by"));
    } else if (n.id >= COMMENT_LO && n.id < COMMENT_HI) {
      push("comment", await db.point(n.id, "commented-by"));
    }
  }
  const linked = new Map<number, LinkedAccount[]>();
  for (const id of approvers) {
    const accounts: LinkedAccount[] = [];
    for (const other of await sameAsNeighbours(db, id)) {
      accounts.push({ id: other, name: await db.pointText(other, "name") });
    }
    if (accounts.length) linked.set(id, accounts);
  }
  return aggregateApproverContext(approvers, activity, linked);
}

/** Approval predicates (idempotent to (re)declare — the engine allows re-sending the same def).
 *  approved-by / approved-at carry the decision; the review trio records the human verdict. */
const APPROVAL_SCHEMA = [
  `{"pred_def":{"name":"approved-by","cardinality":"one","domain":"Issue","range":"Person"}}`,
  `{"pred_def":{"name":"approved-at","cardinality":"one","domain":"Issue","range_value":"int"}}`,
  `{"pred_def":{"name":"approval-review","cardinality":"one","domain":"Issue","range_value":"text"}}`,
  `{"pred_def":{"name":"approval-reviewed-by","cardinality":"one","domain":"Issue","range_value":"text"}}`,
  `{"pred_def":{"name":"approval-review-note","cardinality":"one","domain":"Issue","range_value":"text"}}`,
].join("\n");

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Persist a human-confirmed approval: approved-by + approved-at on the issue, valid from the
 *  comment's event time — an as-of read at any later instant sees who had approved — plus review
 *  facts (the review flywheel — the verdict is itself graph data). Every line carries the
 *  "approval-review" source so the provenance of the decision is queryable. The evidence comment id
 *  stays in the API contract (and in dismissals), not in the facts — the comment's own edges already
 *  tie it to the issue and the approver. */
export async function confirmApproval(
  db: Stroma,
  r: { comment: number; issue: number; approver: number; at: number; reviewer: string; note?: string },
): Promise<void> {
  const facts = [
    `{"fact":{"subject":${r.issue},"predicate":"approved-by","object":{"node":${r.approver}},"valid_from":${r.at},"source":"approval-review"}}`,
    `{"fact":{"subject":${r.issue},"predicate":"approved-at","object":{"int":${r.at}},"valid_from":${r.at},"source":"approval-review"}}`,
    `{"fact":{"subject":${r.issue},"predicate":"approval-review","object":{"text":"confirmed"},"source":"approval-review"}}`,
    `{"fact":{"subject":${r.issue},"predicate":"approval-reviewed-by","object":{"text":"${esc(r.reviewer)}"},"source":"approval-review"}}`,
  ];
  if (r.note) facts.push(`{"fact":{"subject":${r.issue},"predicate":"approval-review-note","object":{"text":"${esc(r.note)}"},"source":"approval-review"}}`);
  await db.ensureAuthed();
  await db.ingest([APPROVAL_SCHEMA, ...facts].join("\n"));
}
