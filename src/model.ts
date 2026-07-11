// The model split. A deployment's model has two parts with different lifecycles:
//
//   SHARED TYPE LAYER  — entity types + predicate declarations (name, cardinality, domain, range —
//                        a lightweight ontology: no axioms, no reasoner). ONE per deployment, shared
//                        across sources so records from different systems land on the same entities
//                        (one shared Person).
//   PER-SOURCE MAPPING — table/field → type/predicate bindings. One per source.
//
// This module owns the split: seeding the layer from the Backlog source's static schema, deriving
// declarations from a full Mapping, diffing/conflict-checking against the layer, and composing
// (layer + bindings) back into the combined Mapping shape the transform consumes.

import type { DerivedRelation, Mapping, Predicate } from "./types.ts";
import type { PredDef, TypeDef } from "./etl/types.ts";
import { SCHEMA as BACKLOG_SCHEMA } from "./backlog.ts";
import { SCHEMA as GDRIVE_SCHEMA } from "./gdrive.ts";

/** A shared-layer predicate: the engine declaration plus model-level policy that never goes over
 *  the ingest wire. `sensitivity` is a FLOOR — facts/claims of this predicate get at least this
 *  access label, whatever their source's own sharing state derived. Automatic assignment may only
 *  RAISE a label above its source-derived tier (ratchet); lowering is always an explicit human edit.
 *  Source ACLs say who currently CAN see a value; the floor says who SHOULD — the type carries the
 *  policy, not the file. */
export interface ModelPredicate extends PredDef {
  /** minimum access label (matches the engine's numeric labels; higher = more sensitive) */
  sensitivity?: number;
}

/** The shared type layer — ONE per deployment; every source maps onto it. */
export interface SharedModel {
  types: TypeDef[];
  predicates: ModelPredicate[];
}

/** One source table/field wired onto a shared-layer predicate — the per-source half of a Predicate. */
export interface PredicateBinding {
  /** name of the shared-layer predicate this binding feeds */
  predicate: string;
  /** provenance in this source: a link table name or "table.column" */
  source: string;
  /** edge-property source columns */
  properties?: string[];
  /** source column whose NULL = still valid */
  valid_end?: string;
}

/** The per-source mapping: bindings only — the declarations live in the shared layer. */
export interface SourceMapping {
  /** source table name → shared graph type */
  entity_types: Record<string, string>;
  bindings: PredicateBinding[];
  /** derived relations confirmed with this source (composed over shared predicates) */
  derived?: DerivedRelation[];
}

/** Names of a mapping's types/predicates that are NOT in the shared layer yet — what a confirm adds. */
export interface ModelAdditions {
  types: string[];
  predicates: string[];
}

/** The seed shared layer: the built-in sources' static declarations (their type_def/pred_def items).
 *  Deduped by name — Backlog and Drive both declare the shared Person (and its name/email), and the
 *  duplicate declarations are identical by construction. */
export function seedModel(): SharedModel {
  const types: TypeDef[] = [];
  const predicates: PredDef[] = [];
  const seenTypes = new Set<string>();
  const seenPreds = new Set<string>();
  for (const item of [...BACKLOG_SCHEMA, ...GDRIVE_SCHEMA]) {
    if ("type_def" in item && !seenTypes.has(item.type_def.name)) {
      types.push({ ...item.type_def });
      seenTypes.add(item.type_def.name);
    } else if ("pred_def" in item && !seenPreds.has(item.pred_def.name)) {
      predicates.push({ ...item.pred_def });
      seenPreds.add(item.pred_def.name);
    }
  }
  return { types, predicates };
}

/** entity-type names in scope when reading a mapping: the shared layer's plus the mapping's own */
function knownTypes(model: SharedModel, mapping: Mapping): Set<string> {
  return new Set([...model.types.map((t) => t.name), ...Object.values(mapping.entity_types)]);
}

/** A mapping Predicate as a shared-layer declaration: `to` is an entity range when it names a known
 *  type, a value range ("text") otherwise — the same split the transform applies when emitting defs. */
function declarationOf(p: Predicate, entityTypes: Set<string>): PredDef {
  return entityTypes.has(p.to)
    ? { name: p.name, cardinality: p.cardinality, domain: p.from, range: p.to }
    : { name: p.name, cardinality: p.cardinality, domain: p.from, range_value: "text" };
}

/** Why an incoming declaration is NOT the existing one (same name) — null when they agree.
 *  Cardinality is load-bearing in the engine, and domain/range give a predicate its meaning, so a
 *  redefinition of any of them is a conflict, never a silent overwrite. */
function declConflict(existing: PredDef, incoming: PredDef): string | null {
  const diffs: string[] = [];
  if (existing.cardinality !== incoming.cardinality) diffs.push(`cardinality ${existing.cardinality} vs ${incoming.cardinality}`);
  if (existing.domain !== incoming.domain) diffs.push(`domain ${existing.domain} vs ${incoming.domain}`);
  const range = (d: PredDef) => d.range ?? `value:${d.range_value ?? "text"}`;
  if (range(existing) !== range(incoming)) diffs.push(`range ${range(existing)} vs ${range(incoming)}`);
  return diffs.length ? diffs.join(", ") : null;
}

/** Every way a mapping's declarations clash with the shared layer (empty = safe to confirm). */
export function conflictsOf(model: SharedModel, mapping: Mapping): string[] {
  const known = knownTypes(model, mapping);
  const byName = new Map(model.predicates.map((p) => [p.name, p]));
  const out: string[] = [];
  for (const p of mapping.predicates) {
    const existing = byName.get(p.name);
    if (!existing) continue;
    const clash = declConflict(existing, declarationOf(p, known));
    if (clash) out.push(`predicate "${p.name}" redefines the shared layer: ${clash}`);
  }
  return out;
}

/** Which of a mapping's types/predicates the shared layer does not have yet. */
export function additionsOf(model: SharedModel, mapping: Mapping): ModelAdditions {
  const haveTypes = new Set(model.types.map((t) => t.name));
  const havePreds = new Set(model.predicates.map((p) => p.name));
  return {
    types: [...new Set(Object.values(mapping.entity_types))].filter((t) => !haveTypes.has(t)),
    predicates: mapping.predicates.map((p) => p.name).filter((n) => !havePreds.has(n)),
  };
}

/** Append a mapping's new declarations to the shared layer in place (conflicts must be checked first). */
export function appendToModel(model: SharedModel, mapping: Mapping): ModelAdditions {
  const added = additionsOf(model, mapping);
  const known = knownTypes(model, mapping);
  for (const t of added.types) model.types.push({ name: t });
  const newPreds = new Set(added.predicates);
  for (const p of mapping.predicates) {
    if (newPreds.has(p.name)) {
      model.predicates.push(declarationOf(p, known));
      newPreds.delete(p.name); // a name appears once in the layer
    }
  }
  return added;
}

/** Strip a confirmed Mapping down to its per-source half — the declarations go to the shared layer. */
export function bindingsOf(mapping: Mapping): SourceMapping {
  const sm: SourceMapping = {
    entity_types: { ...mapping.entity_types },
    bindings: mapping.predicates.map((p) => {
      const b: PredicateBinding = { predicate: p.name, source: p.source };
      if (p.properties?.length) b.properties = [...p.properties];
      if (p.valid_end) b.valid_end = p.valid_end;
      return b;
    }),
  };
  if (mapping.derived?.length) sm.derived = mapping.derived;
  return sm;
}

/** The declared sensitivity floor of a predicate (undefined = no floor). Consumers combine it as
 *  `max(source-derived label, floor)` — the ratchet direction; they never use it to lower. */
export function sensitivityFloor(model: SharedModel, predicate: string): number | undefined {
  return model.predicates.find((p) => p.name === predicate)?.sensitivity;
}

/** Compose (shared layer + per-source bindings) into the combined Mapping the transform consumes. */
export function composeMapping(model: SharedModel, sm: SourceMapping): Mapping {
  const byName = new Map(model.predicates.map((p) => [p.name, p]));
  const predicates: Predicate[] = sm.bindings.map((b) => {
    const decl = byName.get(b.predicate);
    if (!decl) throw new Error(`mapping binds predicate "${b.predicate}" which is not in the shared type layer`);
    const p: Predicate = {
      name: decl.name,
      source: b.source,
      from: decl.domain,
      to: decl.range ?? decl.range_value ?? "text",
      cardinality: decl.cardinality,
    };
    if (b.properties?.length) p.properties = [...b.properties];
    if (b.valid_end) p.valid_end = b.valid_end;
    return p;
  });
  const mapping: Mapping = { entity_types: { ...sm.entity_types }, predicates };
  if (sm.derived?.length) mapping.derived = sm.derived;
  return mapping;
}
