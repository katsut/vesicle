// Implicit attribute inference — deterministic, explainable values a source never stated, proposed
// from the graph neighborhood. First instantiation: a document RELATES TO a project because its
// grantees (after same-as identity resolution) are the people active in that project. No embedding,
// no LLM — the supporting facts are citable: grantee → same-as → assigned/commented in project.
//
// Confidence is the inference strength, and it routes the answer (the confidence × stakes idea in
// its simplest form): a UNANIMOUS neighborhood (5/5 resolvable grantees active in P) reads as
// filled — evaluated over the current graph on every request, never stored, so a grant change or a
// new same-as confirmation re-answers it for free. A MAJORITY (3/5) is ambiguous — routed to a
// human, and only that confirmation writes a fact (relates-to-project, provenance
// inference-review) plus the decision's ReviewRecord. Below the floor the inference stays silent.

import type { Stroma } from "./stroma.ts";
import type { BatchItem } from "./etl/types.ts";
import { scanEventGroups, type EventScan, type NamedRef } from "./patterns.ts";

// --- thresholds (all deterministic, all named here) -------------------------------------------------

/** Fewer resolvable grantees than this and the neighborhood is too small to say anything. */
export const INFER_MIN_SUPPORT = 3;
/** Below this share of resolvable grantees the inference stays silent (not even ambiguous). */
export const INFER_FLOOR = 0.5;

// --- pure inference (unit-tested) --------------------------------------------------------------------

/** One supporting grantee: the document-side person, and — when the project activity sits on a
 *  same-as-linked counterpart in another id band — that counterpart (the citation's middle hop). */
export interface Supporter {
  grantee: number;
  via: number | null;
}

export interface DocProjectInference {
  doc: number;
  project: number;
  /** resolvable grantees active in the project */
  support: number;
  /** grantees with ANY project activity after same-as resolution — the denominator */
  resolvable: number;
  /** unanimous neighborhoods fill; majorities route to a human */
  tier: "high" | "ambiguous";
  supporters: Supporter[];
}

export interface InferenceInput {
  /** document → its can-access grantees */
  docs: ReadonlyMap<number, readonly number[]>;
  /** person → same-as-linked persons (symmetric edges, as expand returns them) */
  sameAs: ReadonlyMap<number, readonly number[]>;
  /** person → the projects they are active in (assigned issues / authored comments) */
  activity: ReadonlyMap<number, ReadonlySet<number>>;
}

/** The same-as closure containing `person` (identity chains span more than two bands). Groups are
 *  tiny (a handful of accounts per human), so a per-person BFS is fine. */
function identityGroup(person: number, sameAs: InferenceInput["sameAs"]): number[] {
  const group = [person];
  const seen = new Set(group);
  for (let i = 0; i < group.length; i++) {
    for (const linked of sameAs.get(group[i]!) ?? []) {
      if (!seen.has(linked)) {
        seen.add(linked);
        group.push(linked);
      }
    }
  }
  return group;
}

/** Infer document→project affinities from grant neighborhoods. Deterministic: rows come out in
 *  (doc, project) order, supporters in grantee order. A grantee with no resolvable activity drops
 *  out of the denominator — an unmapped account says nothing either way. */
export function inferDocProjects(input: InferenceInput): DocProjectInference[] {
  const out: DocProjectInference[] = [];
  for (const [doc, grantees] of input.docs) {
    // per grantee: the projects their identity group is active in, and who carries that activity
    const resolved: Array<{ grantee: number; projects: Map<number, number | null> }> = [];
    for (const grantee of new Set(grantees)) {
      const projects = new Map<number, number | null>();
      for (const member of identityGroup(grantee, input.sameAs)) {
        for (const project of input.activity.get(member) ?? []) {
          if (!projects.has(project)) projects.set(project, member === grantee ? null : member);
        }
      }
      if (projects.size) resolved.push({ grantee, projects });
    }
    if (resolved.length < INFER_MIN_SUPPORT) continue;
    const byProject = new Map<number, Supporter[]>();
    for (const r of resolved) {
      for (const [project, via] of r.projects) {
        const list = byProject.get(project);
        const supporter = { grantee: r.grantee, via };
        if (list) list.push(supporter);
        else byProject.set(project, [supporter]);
      }
    }
    for (const [project, supporters] of [...byProject.entries()].sort((a, b) => a[0] - b[0])) {
      if (supporters.length / resolved.length < INFER_FLOOR) continue;
      out.push({
        doc,
        project,
        support: supporters.length,
        resolvable: resolved.length,
        tier: supporters.length === resolved.length ? "high" : "ambiguous",
        supporters: supporters.sort((a, b) => a.grantee - b.grantee),
      });
    }
  }
  return out.sort((a, b) => a.doc - b.doc || a.project - b.project);
}

// --- graph assembly ----------------------------------------------------------------------------------

/** An inference row as the API serves it: ids plus display names, review state attached upstream. */
export interface InferenceRow {
  doc: NamedRef;
  project: NamedRef;
  support: number;
  resolvable: number;
  tier: "high" | "ambiguous";
  supporters: Array<{ grantee: NamedRef; via: NamedRef | null }>;
  /** the relates-to-project fact already exists (a human confirmed it earlier) */
  confirmed: boolean;
}

/** A predicate that may not exist yet (nothing confirmed / no identity ever linked) reads empty. */
async function expandKnown(db: Stroma, subject: number, predicate: string): Promise<number[]> {
  try {
    return await db.expand(subject, predicate);
  } catch (e) {
    if ((e as Error).message.includes("unknown predicate")) return [];
    throw e;
  }
}

/** Assemble the inference input from one patterns scan (documents + their grants, project activity
 *  from issues and comments) plus a same-as expansion per involved person, run the pure inference,
 *  and attach display names and the confirmed state. */
export async function findInferences(db: Stroma, scan?: EventScan): Promise<InferenceRow[]> {
  const s = scan ?? (await scanEventGroups(db));
  const docs = new Map<number, readonly number[]>();
  for (const events of s.docGroups.values()) {
    for (const e of events) docs.set(e.id, e.targets);
  }
  const activity = new Map<number, Set<number>>();
  const act = (groups: Map<number, Array<{ targets: number[] }>>): void => {
    for (const [project, events] of groups) {
      for (const e of events) {
        for (const person of e.targets) {
          let set = activity.get(person);
          if (!set) activity.set(person, (set = new Set()));
          set.add(project);
        }
      }
    }
  };
  act(s.issueGroups);
  act(s.commentGroups);

  const persons = new Set<number>(activity.keys());
  for (const grantees of docs.values()) {
    for (const g of grantees) persons.add(g);
  }
  const sameAs = new Map<number, readonly number[]>();
  for (const p of persons) {
    const linked = await expandKnown(db, p, "same-as");
    if (linked.length) sameAs.set(p, linked);
  }

  const rows = inferDocProjects({ docs, sameAs, activity });
  const ref = (id: number): NamedRef => ({ id, name: s.names.get(id) ?? null });
  const out: InferenceRow[] = [];
  for (const r of rows) {
    const existing = await expandKnown(db, r.doc, "relates-to-project");
    out.push({
      doc: ref(r.doc),
      project: ref(r.project),
      support: r.support,
      resolvable: r.resolvable,
      tier: r.tier,
      supporters: r.supporters.map((x) => ({ grantee: ref(x.grantee), via: x.via != null ? ref(x.via) : null })),
      confirmed: existing.includes(r.project),
    });
  }
  return out;
}

// --- confirmed writes --------------------------------------------------------------------------------

/** Provenance on the confirmed fact (the ReviewRecord rides separately as human-review). */
export const INFERENCE_REVIEW_ID = "inference-review";

/** The confirmed inference as a self-contained batch: the predicate declaration + ONE fact. Only
 *  ambiguous inferences are ever written — a unanimous neighborhood stays evaluated, not stored,
 *  so it keeps re-answering as the graph changes. */
export function confirmedInferenceBatch(doc: number, project: number, at: number): BatchItem[] {
  return [
    { pred_def: { name: "relates-to-project", cardinality: "many", domain: "Document", range: "Project" } },
    { fact: { subject: doc, predicate: "relates-to-project", object: { node: project }, valid_from: at, source: INFERENCE_REVIEW_ID } },
  ];
}
