// The engine's JSONL ingest records as a typed union. Sources produce `BatchItem[]`; only the sink
// decides how a batch goes over the wire. Shapes mirror what transform.ts / backlog.ts emit and
// stroma-serve accepts: type_def / pred_def / rule_def / node / fact / retract.

import type { Cardinality } from "../types.ts";
import type { Rule } from "../conformance.ts";

/** A fact/retract object: a node reference or a text value. */
export type FactObject = { node: number } | { text: string };

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

export type BatchItem =
  | { type_def: TypeDef }
  | { pred_def: PredDef }
  | { rule_def: RuleDef }
  | { node: NodeRecord }
  | { fact: Fact }
  | { retract: Retract };
