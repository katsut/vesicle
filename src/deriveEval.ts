// Evaluate a DERIVED relation by composing base predicates over the current facts — never storing an
// edge. The design finding this implements: a derived relation (e.g. a person's skip-level manager =
// the manager of their manager) must be EVALUATED over time-stamped base facts. One base change then
// flips every dependent answer for free, with valid-time history; a stored edge goes stale.
//
// Prototype scope: 2-hop paths, one/many cardinality, no branching/filters/aggregation.
//   one-cardinality hop  → point   (with valid-time as-of when `asOf` is given)
//   many-cardinality hop → expand
// A hop's effective travel direction ("forward" = domain→range, "reverse" = range→domain) is checked
// for type composition here, but the engine's point/expand are forward-only, so reverse hops can be
// authored/type-checked yet are reported as not-evaluable in this build (no reverse index yet).

import type { DerivedRelation, Mapping, Predicate } from "./types.ts";
import type { Stroma } from "./stroma.ts";

/** A single composition error, keyed to the offending hop (`hop = -1` = whole-path issue). */
export interface PathError {
  hop: number;
  message: string;
}

function predIndex(mapping: Mapping): Map<string, Predicate> {
  return new Map(mapping.predicates.map((p) => [p.name, p]));
}

/** the (from-type, to-type) a hop actually travels, accounting for direction. */
function hopTypes(base: Predicate, direction: "forward" | "reverse"): [string, string] {
  return direction === "forward" ? [base.from, base.to] : [base.to, base.from];
}

/** Mechanical type-check (NO reasoner): path[0]'s from-type must equal `from`, each hop's to-type must
 *  equal the next hop's from-type, and the last hop's to-type must equal `to`. Returns [] when the path
 *  composes. Unknown base predicates are reported and stop the type walk (to avoid cascade noise). */
export function checkDerivedPath(mapping: Mapping, rel: DerivedRelation): PathError[] {
  const errors: PathError[] = [];
  const byName = predIndex(mapping);
  if (rel.path.length === 0) {
    errors.push({ hop: -1, message: "path is empty" });
    return errors;
  }
  let cursor = rel.from; // the type we are standing on before the next hop
  let broken = false;
  rel.path.forEach((hop, i) => {
    const base = byName.get(hop.predicate);
    if (!base) {
      errors.push({ hop: i, message: `unknown base predicate "${hop.predicate}"` });
      broken = true;
      return;
    }
    const [fromT, toT] = hopTypes(base, hop.direction);
    if (fromT !== cursor) {
      errors.push({ hop: i, message: `hop ${i + 1} (${hop.predicate}) starts at ${fromT}, expected ${cursor}` });
    }
    cursor = toT;
  });
  if (!broken && cursor !== rel.to) {
    errors.push({ hop: rel.path.length - 1, message: `path resolves to ${cursor}, expected ${rel.to}` });
  }
  return errors;
}

/** one hop as executed against the engine, for a "show your work" trace in the UI. */
export interface EvalStep {
  predicate: string;
  direction: "forward" | "reverse";
  op: "point" | "expand";
  /** the node ids this hop produced (the frontier after the hop) */
  reached: number[];
}

export interface EvalResult {
  subject: number;
  asOf: number | null;
  cardinality: DerivedRelation["cardinality"];
  /** all node ids reached at the end of the path */
  result: number[];
  /** for a one-cardinality relation, the single node (or null); undefined for many */
  one: number | null;
  steps: EvalStep[];
}

/** Evaluate `rel` from `subject`, optionally valid-time as-of `asOf`. Chains point/expand over the path
 *  via the Stroma client — no edge is stored. Throws on a non-composing path or a reverse hop. */
export async function evaluateDerived(
  db: Stroma,
  mapping: Mapping,
  rel: DerivedRelation,
  subject: number,
  asOf?: number,
): Promise<EvalResult> {
  const errors = checkDerivedPath(mapping, rel);
  if (errors.length) throw new Error(`derived path does not compose: ${errors.map((e) => e.message).join("; ")}`);
  const byName = predIndex(mapping);

  const steps: EvalStep[] = [];
  let frontier: number[] = [subject];
  for (const hop of rel.path) {
    const base = byName.get(hop.predicate)!; // checkDerivedPath guaranteed it exists
    if (hop.direction === "reverse") {
      throw new Error(`reverse hop "${hop.predicate}" is not evaluable in this build (engine has no reverse index yet)`);
    }
    const op: "point" | "expand" = base.cardinality === "one" ? "point" : "expand";
    const next = new Set<number>();
    for (const node of frontier) {
      if (op === "point") {
        const hit = asOf != null ? await db.pointAsOf(node, hop.predicate, asOf) : await db.point(node, hop.predicate);
        if (hit != null) next.add(hit);
      } else {
        for (const n of await db.expand(node, hop.predicate)) next.add(n);
      }
    }
    frontier = [...next];
    steps.push({ predicate: hop.predicate, direction: hop.direction, op, reached: frontier });
  }

  return {
    subject,
    asOf: asOf ?? null,
    cardinality: rel.cardinality,
    result: frontier,
    one: rel.cardinality === "one" ? (frontier[0] ?? null) : null,
    steps,
  };
}
