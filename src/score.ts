// Port of the B2 kit's score.py: grade a mapping by the DOWNSTREAM staffing query (the 本丸 metric),
// name-agnostic — predicates are matched by their `source`, entities by which table got the person type.
// A mapping's modeling mistakes still propagate: unmapped employee_skills → recall 0; has-skill
// cardinality "one" → recall drops; untyped employees → recall 0.

import type { Mapping, SchemaModel } from "./types.ts";

const PROJECT_PK = 3; // "ML Recommender"
const TOPK = 5;
const GOLD_SOURCES: Record<string, Set<string>> = {
  employee_skills: new Set(["many"]),
  project_skills: new Set(["many"]),
  "employees.department_id": new Set(["one"]),
  "employees.manager_id": new Set(["one"]),
  assignments: new Set(["one", "many"]),
};
const CRITICAL = new Set(["employee_skills", "project_skills"]);

type Rows = Record<string, Array<Record<string, unknown>>>;

interface Built {
  candidateType: string | undefined;
  personSkills: Map<string, Set<number>>;
  projectNeeds: Map<string, Set<number>>;
}

function build(data: Rows, m: Mapping): Built {
  const preds = m.predicates ?? [];
  const candidateType = m.entity_types?.["employees"];
  const empCard = preds.find((p) => p.source === "employee_skills")?.cardinality ?? null;
  const projMapped = preds.some((p) => p.source === "project_skills");

  const personSkills = new Map<string, Set<number>>();
  if (empCard) {
    for (const r of data["employee_skills"] ?? []) {
      const k = `employees:${r["employee_id"]}`;
      if (!personSkills.has(k)) personSkills.set(k, new Set());
      personSkills.get(k)!.add(Number(r["skill_id"]));
    }
    if (empCard === "one") for (const [k, v] of personSkills) personSkills.set(k, new Set([...v].slice(0, 1)));
  }
  const projectNeeds = new Map<string, Set<number>>();
  if (projMapped) {
    for (const r of data["project_skills"] ?? []) {
      const k = `projects:${r["project_id"]}`;
      if (!projectNeeds.has(k)) projectNeeds.set(k, new Set());
      projectNeeds.get(k)!.add(Number(r["skill_id"]));
    }
  }
  return { candidateType, personSkills, projectNeeds };
}

function refQuery(data: Rows, b: Built): string[] {
  const needs = b.projectNeeds.get(`projects:${PROJECT_PK}`);
  if (!needs || !b.candidateType) return [];
  const scored: Array<[number, number, string]> = [];
  for (const row of data["employees"] ?? []) {
    const nid = `employees:${row["id"]}`;
    const overlap = [...(b.personSkills.get(nid) ?? [])].filter((s) => needs.has(s)).length;
    if (overlap > 0) scored.push([overlap, -Number(row["id"]), nid]);
  }
  scored.sort((x, y) => y[0] - x[0] || y[1] - x[1]);
  return scored.slice(0, TOPK).map((s) => s[2]);
}

export interface Score {
  recall: number;
  precision: number;
  typeViolations: number;
  sourceCapture: number;
  criticalPresent: boolean;
}

export function scoreMapping(_schema: SchemaModel, data: Rows, gold: Mapping, mapping: Mapping): Score {
  const goldRes = refQuery(data, build(data, gold));
  const testRes = refQuery(data, build(data, mapping));
  const inter = testRes.filter((x) => goldRes.includes(x));
  const recall = goldRes.length ? inter.length / goldRes.length : 0;
  const precision = testRes.length ? inter.length / testRes.length : 0;
  const typeViolations = testRes.filter((nid) => !nid.startsWith("employees:")).length;

  const testSources = new Set((mapping.predicates ?? []).map((p) => p.source));
  const sourceCapture = Object.keys(GOLD_SOURCES).filter((s) => testSources.has(s)).length / Object.keys(GOLD_SOURCES).length;
  const criticalPresent = [...CRITICAL].every((s) => testSources.has(s));
  return { recall, precision, typeViolations, sourceCapture, criticalPresent };
}
