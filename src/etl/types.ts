// The engine's JSONL ingest records as a typed union. Sources produce `BatchItem[]`; only the sink
// decides how a batch goes over the wire. Shapes mirror what transform.ts / backlog.ts emit and
// stroma-serve accepts: type_def / pred_def / rule_def / node / fact / retract / close.

import type { Cardinality } from "../types.ts";
import type { Rule } from "../conformance.ts";

/** A fact/retract object: a node reference or a scalar value (the engine's wire accepts
 *  node|int|float|text|bool; only the kinds a connector emits are modeled here). */
export type FactObject = { node: number } | { text: string } | { int: number } | { bool: boolean };

export interface TypeDef {
  name: string;
}

export interface PredDef {
  name: string;
  cardinality: Cardinality;
  domain: string;
  /** entity-valued range — exactly one of range / range_value is set */
  range?: string;
  /** value-valued range, e.g. "text" */
  range_value?: string;
  /** this predicate's text value labels its subject node in the engine's graph views */
  display?: boolean;
}

/** A named conformance rule, declared once and evaluated by name. */
export interface RuleDef {
  name: string;
  rule: Rule;
}

export interface NodeRecord {
  id: number;
  type: string;
  /** ABAC sensitivity label */
  label?: number;
}

export interface Fact {
  subject: number;
  predicate: string;
  object: FactObject;
  /** edge properties (bare scalar values) */
  props?: Record<string, number | string | boolean>;
  valid_from?: number;
  valid_to?: number;
  /** provenance — the sink stamps the pipeline id when unset */
  source?: string;
}

export interface Retract {
  subject: number;
  predicate: string;
  object: FactObject;
  source?: string;
}

/** End a cardinality-one value with no successor: head becomes absent; as-of at/after `valid_from`
 *  returns nothing, before it still sees the prior value. Only the event source knows a value ended
 *  (the engine cannot infer cessation), so connectors emit this for field-cleared events. */
export interface Close {
  subject: number;
  predicate: string;
  valid_from?: number;
  /** provenance — the sink stamps the pipeline id when unset */
  source?: string;
}

export type BatchItem =
  | { type_def: TypeDef }
  | { pred_def: PredDef }
  | { rule_def: RuleDef }
  | { node: NodeRecord }
  | { fact: Fact }
  | { retract: Retract }
  | { close: Close };
