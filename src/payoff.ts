// The payoff query, run against the REAL ingested graph via StromaDB expands only (no reverse index
// needed): "who is a good fit to staff a project that needs certain skills?"
//
// Roles are found by graph STRUCTURE, not predicate names (the LLM names them freely):
//   personType = type of the employees table, skillType = type of skills, projectType = type of projects
//   has-skill  = predicate from personType  → skillType
//   needs-skill= predicate from projectType → skillType

import type { Mapping } from "./types.ts";
import type { Stroma } from "./stroma.ts";
import type { TransformResult } from "./transform.ts";

export interface FitRow {
  name: string;
  overlap: number;
  /** sum of the numeric edge property (skill level) over matched skills — the "strength" signal */
  strength: number;
  /** sum of the numeric edge property (allocation %) over the person's assignment edges — "busyness" */
  busyness: number;
  /** strength − busyness·factor: strong *and* available ranks highest */
  score: number;
  skills: string[];
}

/** how much current allocation discounts strength (allocation ~40–50 vs strength ~7–9) */
const BUSY_FACTOR = 0.1;

export interface PayoffPlan {
  personType: string;
  skillType: string;
  projectType: string;
  hasPred: string;
  needsPred: string;
  /** assignment edges (person→project) busyness reads. `card`='one' ⇒ current membership answered by
   *  the engine's valid-time (point `valid_at`); `endCol` = the end-marker edge property used to filter
   *  ended edges on a many-edge (whose valid-time can't live in the engine). */
  assignPreds: Array<{ name: string; card: "one" | "many"; endCol?: string }>;
}

/** demo "now" as a YYYYMMDD instant: an assignment whose end marker is at/before this has ended. */
const NOW = 20250701;

export function planPayoff(mapping: Mapping): PayoffPlan | { error: string } {
  const t = mapping.entity_types;
  const personType = t["employees"];
  const projectType = t["projects"];
  const skillType = t["skills"];
  if (!skillType) return { error: "skills is not an entity type — skill-matching cannot run" };
  if (!personType || !projectType) return { error: "employees/projects not typed as entities" };

  const has = mapping.predicates.find((p) => p.from === personType && p.to === skillType);
  const needs = mapping.predicates.find((p) => p.from === projectType && p.to === skillType);
  if (!has) return { error: `no has-skill predicate (${personType}→${skillType})` };
  if (!needs) return { error: `no needs-skill predicate (${projectType}→${skillType})` };
  // assignment edges = person→project predicates carrying edge properties (allocation, and — on a
  // many-edge — an end marker property derived from valid_end).
  const assignPreds = mapping.predicates
    .filter((p) => p.from === personType && p.to === projectType && (p.properties?.length || p.valid_end))
    .map((p) => ({ name: p.name, card: p.cardinality, endCol: p.cardinality !== "one" ? p.valid_end : undefined }));
  return { personType, skillType, projectType, hasPred: has.name, needsPred: needs.name, assignPreds };
}

export async function runPayoff(
  db: Stroma,
  tr: TransformResult,
  plan: PayoffPlan,
  targetProjectGid: number,
  labelOf: (gid: number) => string,
): Promise<FitRow[]> {
  const needs = new Set(await db.expand(targetProjectGid, plan.needsPred));
  const persons = Object.values(tr.idMap[plan.personType] ?? {});
  const rows: FitRow[] = [];
  for (const pg of persons) {
    const skills = await db.expand(pg, plan.hasPred);
    const hit = skills.filter((s) => needs.has(s));
    if (hit.length === 0) continue;
    // strength = sum of the numeric edge property (skill level) over the matched has-skill edges;
    // falls back to the match count when no level was carried.
    let strength = 0;
    for (const s of hit) {
      const props = await db.edgeProps(pg, plan.hasPred, s);
      const level = Object.values(props).find((v) => typeof v === "number") as number | undefined;
      strength += level ?? 1;
    }
    // busyness = sum of allocation over the person's *current* assignment edges.
    let busyness = 0;
    for (const { name: pred, card, endCol } of plan.assignPreds) {
      const allocOf = async (proj: number) => {
        const props = await db.edgeProps(pg, pred, proj);
        return Object.entries(props).find(([k, v]) => k !== endCol && typeof v === "number")?.[1] as number | undefined;
      };
      if (card === "one") {
        // "current" membership: the engine answers who's on it now via valid-time as-of.
        const cur = await db.pointAsOf(pg, pred, NOW);
        if (cur != null) busyness += (await allocOf(cur)) ?? 0;
      } else {
        // "history" many-edge: filter ended edges by their end-marker property (app-side).
        for (const proj of await db.expand(pg, pred)) {
          const props = await db.edgeProps(pg, pred, proj);
          const end = endCol ? (props[endCol] as number | undefined) : undefined;
          if (end != null && end <= NOW) continue; // ended — not a current commitment
          busyness += (Object.entries(props).find(([k, v]) => k !== endCol && typeof v === "number")?.[1] as number | undefined) ?? 0;
        }
      }
    }
    const score = strength - busyness * BUSY_FACTOR;
    rows.push({ name: labelOf(pg), overlap: hit.length, strength, busyness, score, skills: hit.map(labelOf) });
  }
  // rank by score (strong *and* available), then strength, then name — edge properties drive the order.
  rows.sort((a, b) => b.score - a.score || b.strength - a.strength || a.name.localeCompare(b.name));
  return rows;
}
