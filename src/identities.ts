// Cross-source identity resolution — the review flywheel on Person identity. The shared Person type
// makes instance-level duplication visible: the same human appears as a Backlog-band Person and a
// Drive-band Person (different native ids, possibly different registered emails), so no automatic
// merge is possible or safe. Candidate generation is deterministic and token-zero (email or
// display-name agreement across id bands); a human confirms or dismisses each pair; a confirmed
// identity is asserted as a symmetric `same-as` edge plus review facts on BOTH nodes — the same
// review idiom as src/review.ts and src/access-conformance.ts.

import type { Stroma } from "./stroma.ts";

/** Person id bands = source families. Backlog persons sit at BASE.Person (src/backlog.ts), Drive
 *  persons at BAND.Person (src/gdrive.ts); persons authored through the wizard sources keep their
 *  small native ids below every band. */
export type Band = "hr" | "backlog" | "drive";

const BACKLOG_LO = 1_000_000_000_000; // src/backlog.ts BASE.Person
const BACKLOG_HI = 2_000_000_000_000;
const DRIVE_LO = 7 * 2 ** 48; // src/gdrive.ts BAND.Person
const DRIVE_HI = 8 * 2 ** 48;

/** Which source family minted this Person id — null for ids outside every Person band. */
export function personBand(id: number): Band | null {
  if (id >= DRIVE_LO && id < DRIVE_HI) return "drive";
  if (id >= BACKLOG_LO && id < BACKLOG_HI) return "backlog";
  if (id >= 0 && id < BACKLOG_LO) return "hr";
  return null;
}

export interface PersonInfo {
  id: number;
  name: string | null;
  email: string | null;
}

export type Evidence = "email" | "name";

export interface CandidatePair {
  a: PersonInfo;
  b: PersonInfo;
  /** what matched: exact normalized email (strong) or display-name token set */
  evidence: Evidence;
}

/** A candidate pair with its graph state: confirmed = a same-as edge already links it. */
export interface Candidate extends CandidatePair {
  confirmed: boolean;
}

// Drive marks a permission whose grantee no longer exists with this display name (src/gdrive.ts);
// such nodes are placeholders, not people to identify.
const DELETED = "(deleted account)";

const normEmail = (e: string): string => e.trim().toLowerCase();

/** Display-name token set: lowercased, split on whitespace/dots/hyphens/underscores, order ignored —
 *  "jane.doe" ≡ "Jane Doe". Single-token names are too weak to pair on (see pairPersons). */
export function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[\s.\-_]+/).filter(Boolean));
}

const sameSet = (x: Set<string>, y: Set<string>): boolean => x.size === y.size && [...x].every((t) => y.has(t));

/** Deterministic candidate generation over an already-gathered person list (pure — unit-tested).
 *  Pairs cross bands only: a same-band duplicate is a source-keying problem, out of scope here.
 *  Evidence: exact normalized-email equality (strong), else equal name token sets with ≥2 tokens —
 *  a differing email does NOT veto a name match (the observed live duplicate had different
 *  registered emails). Each pair is ordered a.id < b.id so (a, b) is a stable key. */
export function pairPersons(persons: PersonInfo[]): CandidatePair[] {
  const eligible = persons.filter((p) => personBand(p.id) != null && p.name !== DELETED);
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const x = eligible[i]!;
      const y = eligible[j]!;
      if (personBand(x.id) === personBand(y.id)) continue;
      const [a, b] = x.id < y.id ? [x, y] : [y, x];
      if (a.email && b.email && normEmail(a.email) === normEmail(b.email)) {
        pairs.push({ a, b, evidence: "email" });
        continue;
      }
      if (a.name && b.name) {
        const ta = nameTokens(a.name);
        if (ta.size >= 2 && sameSet(ta, nameTokens(b.name))) pairs.push({ a, b, evidence: "name" });
      }
    }
  }
  return pairs;
}

/** A text property out of the node-detail response ({props: [{predicate, card, value|values}]}).
 *  Tolerant of the value arriving wrapped ({text: …}) or as a bare string. */
function propText(detail: Record<string, unknown>, predicate: string): string | null {
  const props = (detail.props as Array<{ predicate?: string; value?: unknown }>) ?? [];
  const v = props.find((p) => p.predicate === predicate)?.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
  return null;
}

/** The person's registered email, or null. Tolerant of the predicate not being registered yet. */
async function personEmail(db: Stroma, id: number): Promise<string | null> {
  try {
    return await db.pointText(id, "email");
  } catch (e) {
    if ((e as Error).message.includes("unknown predicate")) return null;
    throw e;
  }
}

/** The same-as neighbours of a node. The predicate not existing yet (nothing confirmed anywhere)
 *  is a normal state, not an error. */
async function sameAs(db: Stroma, id: number, cache: Map<number, number[]>): Promise<number[]> {
  const hit = cache.get(id);
  if (hit) return hit;
  let nodes: number[];
  try {
    nodes = await db.expand(id, "same-as");
  } catch (e) {
    if (!(e as Error).message.includes("unknown predicate")) throw e;
    nodes = [];
  }
  cache.set(id, nodes);
  return nodes;
}

/** Scan the graph for Person nodes and generate cross-band candidates, each annotated with its
 *  confirmed state (an existing same-as edge — symmetric, so one direction suffices). The person
 *  population is small (~hundreds), so one node-detail read per person-band id is acceptable; ids
 *  outside the Person bands are skipped without a read. */
export async function findCandidates(db: Stroma): Promise<Candidate[]> {
  await db.ensureAuthed();
  const g = await db.query({ op: "graph", max_nodes: 3000 });
  const nodes = (g.nodes as Array<{ id: number; name?: string }>) ?? [];
  const persons: PersonInfo[] = [];
  for (const n of nodes) {
    if (personBand(n.id) == null) continue; // not a Person band — no read needed
    const detail = await db.node(n.id);
    if (detail.type !== "Person") continue; // the small-id band holds other wizard-authored types too
    persons.push({ id: n.id, name: propText(detail, "name") ?? n.name ?? null, email: await personEmail(db, n.id) });
  }
  const out: Candidate[] = [];
  const cache = new Map<number, number[]>();
  for (const p of pairPersons(persons)) {
    out.push({ ...p, confirmed: (await sameAs(db, p.a.id, cache)).includes(p.b.id) });
  }
  return out;
}

/** Identity predicates (idempotent to (re)declare — the engine allows re-sending the same def).
 *  `same-as` is symmetric: the engine's expand follows it both ways, so ONE edge covers the pair. */
const IDENTITY_SCHEMA = [
  `{"pred_def":{"name":"same-as","cardinality":"many","domain":"Person","range":"Person","symmetric":true}}`,
  `{"pred_def":{"name":"identity-review","cardinality":"one","domain":"Person","range_value":"text"}}`,
  `{"pred_def":{"name":"identity-reviewed-by","cardinality":"one","domain":"Person","range_value":"text"}}`,
  `{"pred_def":{"name":"identity-review-note","cardinality":"one","domain":"Person","range_value":"text"}}`,
].join("\n");

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Persist a human-confirmed identity: the symmetric same-as edge plus review facts on BOTH nodes
 *  (the review flywheel — the verdict is itself graph data). Every line carries the
 *  "identity-review" source so the provenance of the merge is queryable. */
export async function confirmIdentity(db: Stroma, r: { a: number; b: number; reviewer: string; note?: string }): Promise<void> {
  const facts = [`{"fact":{"subject":${r.a},"predicate":"same-as","object":{"node":${r.b}},"source":"identity-review"}}`];
  for (const subject of [r.a, r.b]) {
    facts.push(`{"fact":{"subject":${subject},"predicate":"identity-review","object":{"text":"confirmed"},"source":"identity-review"}}`);
    facts.push(`{"fact":{"subject":${subject},"predicate":"identity-reviewed-by","object":{"text":"${esc(r.reviewer)}"},"source":"identity-review"}}`);
    if (r.note) facts.push(`{"fact":{"subject":${subject},"predicate":"identity-review-note","object":{"text":"${esc(r.note)}"},"source":"identity-review"}}`);
  }
  await db.ensureAuthed();
  await db.ingest([IDENTITY_SCHEMA, ...facts].join("\n"));
}
