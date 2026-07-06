// Suggest meaningful DERIVED relations from the confirmed base predicates. A derived relation is a
// named path composed over base predicates and EVALUATED on read (never stored) — e.g. a person's
// skip-level manager is the manager of their manager.
//
// Two paths, both graceful:
//   LLM      — ask the model to name 2-hop compositions with a plain-language rationale.
//   MECHANICAL — if the LLM is unavailable or returns nothing usable, compose every valid forward
//                2-hop path over the base predicates. The server type-checks every candidate before
//                returning it, so a bad suggestion is dropped rather than shown.

import type { DerivedRelation, Mapping, Predicate } from "./types.ts";
import { callLLM, extractJson } from "./llm.ts";

const INSTRUCTIONS = `You extend a confirmed knowledge-graph mapping with DERIVED relations. A derived
relation has a name and a PATH of 2 hops over the base predicates below; it is evaluated by following
the path over the current facts, never stored. Example: if "manager-of" links Person → Person, then a
person's skip-level manager is manager-of then manager-of again.

Rules:
- Use ONLY the base predicates listed. Each hop names one of them and a direction: "forward" walks it
  from-type → to-type, "reverse" walks to-type → from-type.
- The path must compose: hop 1 starts at the relation's "from" type; each hop's end type equals the
  next hop's start type; the last hop ends at the relation's "to" type.
- Exactly 2 hops. No filters, no branching, no aggregation.
- cardinality is "one" only when BOTH hops are one-cardinality (forward), else "many".
- Prefer relations a business user would actually name and ask for. Skip trivial or redundant ones.

Output ONLY a JSON object, no prose, in exactly this shape:
{
  "derived": [
    { "name": "<kebab-name>", "from": "<GraphType>", "to": "<GraphType>", "cardinality": "one|many",
      "path": [ { "predicate": "<base>", "direction": "forward|reverse" },
                { "predicate": "<base>", "direction": "forward|reverse" } ],
      "rationale": "<one plain-language sentence>" }
  ]
}`;

function predicatesForPrompt(mapping: Mapping): string {
  return mapping.predicates
    .map((p) => `  ${p.name}: ${p.from} → ${p.to} (${p.cardinality})`)
    .join("\n");
}

export function buildDerivedPrompt(mapping: Mapping): string {
  const types = [...new Set(Object.values(mapping.entity_types))].join(", ");
  return `${INSTRUCTIONS}\n\nGRAPH TYPES: ${types}\n\nBASE PREDICATES:\n${predicatesForPrompt(mapping)}\n`;
}

/** Ask the LLM for derived relations. Returns [] on any failure (caller falls back to the composer). */
export async function proposeDerived(mapping: Mapping): Promise<DerivedRelation[]> {
  try {
    const text = await callLLM(buildDerivedPrompt(mapping), { timeoutMs: 60_000 });
    const obj = extractJson(text) as { derived?: unknown };
    const list = Array.isArray(obj.derived) ? obj.derived : [];
    return list.filter(isDerivedShape);
  } catch {
    return [];
  }
}

function isDerivedShape(v: unknown): v is DerivedRelation {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.from === "string" &&
    typeof r.to === "string" &&
    (r.cardinality === "one" || r.cardinality === "many") &&
    Array.isArray(r.path) &&
    r.path.every((h) => {
      if (typeof h !== "object" || h === null) return false;
      const hop = h as Record<string, unknown>;
      return typeof hop.predicate === "string" && (hop.direction === "forward" || hop.direction === "reverse");
    })
  );
}

/** how many mechanical suggestions to surface (the LLM path curates; this fallback stays lean). */
const MAX_COMPOSED = 6;

/** Compose every valid forward 2-hop path over the base predicates. Self-composition (p ∘ p, e.g. a
 *  self-referential manager-of) is allowed — that is exactly the skip-level case. Deterministic, no LLM.
 *  one∘one compositions come first (the ones a business user is most likely to name), then capped. */
export function composeDerived(mapping: Mapping): DerivedRelation[] {
  const preds = mapping.predicates;
  const out: DerivedRelation[] = [];
  const seen = new Set<string>();
  for (const p1 of preds) {
    for (const p2 of preds) {
      if (p1.to !== p2.from) continue; // must compose: p1 ends where p2 starts
      const key = `${p1.name}|${p2.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cardinality = p1.cardinality === "one" && p2.cardinality === "one" ? "one" : "many";
      out.push({
        name: composeName(p1, p2),
        from: p1.from,
        to: p2.to,
        cardinality,
        path: [
          { predicate: p1.name, direction: "forward" },
          { predicate: p2.name, direction: "forward" },
        ],
        rationale: `Follow ${p1.name} then ${p2.name}: a ${p1.from} reaches a ${p2.to} without storing an edge.`,
      });
    }
  }
  out.sort((a, b) => Number(b.cardinality === "one") - Number(a.cardinality === "one"));
  return out.slice(0, MAX_COMPOSED);
}

/** a readable kebab name for a 2-hop composition (self-composition gets a "skip-level" prefix). */
function composeName(p1: Predicate, p2: Predicate): string {
  if (p1.name === p2.name) return `skip-level-${p1.name.replace(/-of$/, "")}`;
  return `${p1.name}-then-${p2.name}`;
}
