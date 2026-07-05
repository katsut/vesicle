// Shared model for the source→graph pipeline. The Mapping shape mirrors the sample kit's
// gold_mapping.json (entity_types + predicates{name,source,from,to,cardinality}) so score.py can grade
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

export interface Mapping {
  /** source table name → graph entity type */
  entity_types: Record<string, string>;
  predicates: Predicate[];
  /** optional per-decision rationale keyed by predicate name or "type:<table>" — for the confirm UI */
  rationale?: Record<string, string>;
}
