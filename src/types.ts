// Shared model for the source→graph pipeline. The Mapping shape (entity_types +
// predicates{name,source,from,to,cardinality}) mirrors the sample kit's mapping format;
// two fields that real sources need are added on top:
//   - predicate.properties : edge attributes (level, role, allocation) — the "details you'd forget"
//   - predicate.valid_end  : the source column whose NULL means "current" — valid-time

export type Cardinality = "one" | "many";

export interface Column {
  name: string;
  type: string;
  pk: boolean;
  /** referenced "table.column" if this column is a foreign key */
  ref: string | null;
}

export interface Table {
  name: string;
  columns: Column[];
  /** composite primary key column names (empty when a single-column pk is on a Column) */
  pk: string[];
  /** a table that exists only to link two others (all non-pk-or-attr columns are FKs to 2 tables) */
  isJoin: boolean;
  /** for a join table: the two tables it links */
  joins: [string, string] | null;
}

export interface SchemaModel {
  tables: Table[];
}

export interface Predicate {
  name: string;
  /** provenance: which source table/column this predicate is derived from */
  source: string;
  from: string;
  to: string;
  cardinality: Cardinality;
  /** edge-property source columns */
  properties?: string[];
  /** source column whose NULL = still valid */
  valid_end?: string;
}

/** one step of a derived-relation path, traversing a BASE predicate in `Mapping.predicates`.
 *  "forward" walks the predicate domain→range; "reverse" walks range→domain. */
export interface PathHop {
  predicate: string;
  direction: "forward" | "reverse";
}

/** A relationship that is not stored but EVALUATED by composing base predicates over the current
 *  facts (e.g. a person's skip-level manager = the manager of their manager). Evaluating it means one
 *  base change flips every dependent answer for free, with valid-time history — never a stale edge.
 *  Prototype scope: 2-hop paths, one/many cardinality; no branching, filters, or aggregation. */
export interface DerivedRelation {
  /** kebab name, e.g. "skip-level-manager" */
  name: string;
  /** GraphType the relation starts from (must equal path[0]'s from-type) */
  from: string;
  /** GraphType the relation resolves to (must equal the last hop's to-type) */
  to: string;
  cardinality: Cardinality;
  /** hops over BASE predicates; each hop's to-type must equal the next hop's from-type */
  path: PathHop[];
  /** "query-time" (evaluate on read; default) or "materialized" (kept in sync) */
  eval?: "query-time" | "materialized";
  /** one plain-language sentence for the confirm UI */
  rationale?: string;
}

export interface Mapping {
  /** source table name → graph entity type */
  entity_types: Record<string, string>;
  predicates: Predicate[];
  /** derived relations composed over `predicates` — evaluated, not stored */
  derived?: DerivedRelation[];
  /** optional per-decision rationale keyed by predicate name or "type:<table>" — for the confirm UI */
  rationale?: Record<string, string>;
}
