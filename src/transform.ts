// Turn confirmed mapping + source rows into StromaDB ingest batch items.
//
// The engine's ingest is triples: type_def / pred_def(domain,range) / node / fact(object=node|value).
// It does NOT yet carry edge properties (level, allocation, role) or valid-time on a fact — so those,
// though the authoring layer correctly proposes them, are reported as `gaps` here rather than ingested.
// That gap IS a finding: the confirm UX surfaces edge attributes the MVP engine can't store yet.

import type { Mapping, SchemaModel, Table } from "./types.ts";
import type { BatchItem, Fact, NodeRecord } from "./etl/types.ts";

/** A note from the transform. `code` + `params` let a UI localize it; `text` is the English default. */
export interface Gap {
  code: string;
  params: Record<string, string>;
  text: string;
}

export interface TransformResult {
  /** engine ingest records (defs + nodes + facts); the sink owns their wire encoding */
  items: BatchItem[];
  /** graph-type → (source pk value → global node id) */
  idMap: Record<string, Record<string, number>>;
  /** source table → graph type */
  typeOf: Record<string, string>;
  gaps: Gap[];
}

type Rows = Record<string, Array<Record<string, unknown>>>;

function tableOf(schema: SchemaModel, name: string): Table | undefined {
  return schema.tables.find((t) => t.name === name);
}

/** "YYYY-MM-DD" → a monotonic integer instant (YYYYMMDD) for the engine's valid_to; null → open. */
function dateToInt(v: unknown): number | undefined {
  if (v == null) return undefined;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Number(`${m[1]}${m[2]}${m[3]}`) : undefined;
}

/** A prop value for the engine: numbers/strings/bools pass through as bare JSON. */
function propValue(v: unknown): number | string | boolean | undefined {
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return undefined;
}
function pkCol(t: Table | undefined): string {
  return t?.pk[0] ?? "id";
}
/** the FK column on `table` that references `refTable` (or self for a self-ref) */
function fkTo(t: Table | undefined, refTable: string): string | undefined {
  return t?.columns.find((c) => c.ref?.split(".")[0] === refTable)?.name;
}

export function transform(schema: SchemaModel, mapping: Mapping, data: Rows): TransformResult {
  const items: BatchItem[] = [];
  const gaps: Gap[] = [];
  const gap = (code: string, params: Record<string, string>, text: string) => gaps.push({ code, params, text });
  const idMap: Record<string, Record<string, number>> = {};
  const typeOf: Record<string, string> = {};
  const tableOfType: Record<string, string> = {};
  let next = 1;

  // 1. entity types + node id assignment
  const seenTypes = new Set<string>();
  for (const [table, gtype] of Object.entries(mapping.entity_types)) {
    typeOf[table] = gtype;
    tableOfType[gtype] = table;
    if (!seenTypes.has(gtype)) {
      items.push({ type_def: { name: gtype } });
      seenTypes.add(gtype);
    }
    idMap[gtype] ??= {};
    const t = tableOf(schema, table);
    const pk = pkCol(t);
    for (const row of data[table] ?? []) {
      const key = String(row[pk]);
      const gid = next++;
      idMap[gtype]![key] = gid;
      // a `label` column becomes the node's ABAC sensitivity label (post-authz: reads scoped by
      // allowed_labels exclude nodes whose label the caller isn't cleared for).
      const node: NodeRecord = { id: gid, type: gtype };
      if (typeof row["label"] === "number") node.label = row["label"];
      items.push({ node });
    }
  }

  const gid = (gtype: string, key: unknown): number | undefined =>
    idMap[gtype]?.[String(key)];

  // 2. predicates + facts
  for (const p of mapping.predicates) {
    const toIsEntity = !!tableOfType[p.to];
    items.push({
      pred_def: toIsEntity
        ? { name: p.name, cardinality: p.cardinality, domain: p.from, range: p.to }
        : { name: p.name, cardinality: p.cardinality, domain: p.from, range_value: "text" },
    });
    // valid_to (an edge's end) is carried as engine valid-time only on a one-cardinality predicate
    // (SetOne). On a many-edge the engine has no valid-time, so the end is carried as an *edge
    // property* instead — the app filters "current vs ended" from it (curation, not a reasoner).
    const carriesValidTime = !!p.valid_end && p.cardinality === "one";
    const endAsProp = !!p.valid_end && p.cardinality !== "one";
    if (endAsProp) {
      gap("valid_end_as_prop", { pred: p.name }, `predicate "${p.name}" valid_end carried as an edge property (many-edge: engine valid-time is one-edge only); app filters ended edges`);
    }

    // build a fact with optional props (edge attributes) + valid_to (end of validity) from a row.
    const emitFact = (subj: number, obj: number, row: Record<string, unknown>) => {
      const fact: Fact = { subject: subj, predicate: p.name, object: { node: obj } };
      const props: Record<string, number | string | boolean> = {};
      if (p.properties?.length) {
        for (const col of p.properties) {
          const pv = propValue(row[col]);
          if (pv !== undefined) props[col] = pv;
        }
      }
      if (endAsProp) {
        const end = dateToInt(row[p.valid_end!]);
        if (end !== undefined) props[p.valid_end!] = end; // end marker as an edge property
      }
      if (Object.keys(props).length) fact.props = props;
      if (carriesValidTime) {
        const vt = dateToInt(row[p.valid_end!]);
        if (vt !== undefined) fact.valid_to = vt;
      }
      items.push({ fact });
    };

    const src = p.source;
    const fromTable = tableOfType[p.from];
    if (!fromTable) {
      gap("from_not_entity", { pred: p.name, from: p.from }, `predicate "${p.name}" from-type ${p.from} is not an entity — skipped`);
      continue;
    }

    // shape A: source is a "table.column" FK on an entity table
    if (src.includes(".")) {
      const [tbl, col] = src.split(".") as [string, string];
      for (const row of data[tbl] ?? []) {
        const subj = gid(typeOf[tbl] ?? p.from, row[pkCol(tableOf(schema, tbl))]);
        const val = row[col];
        if (subj == null || val == null) continue;
        if (toIsEntity) {
          const obj = gid(p.to, val);
          if (obj != null) emitFact(subj, obj, row);
        } else {
          items.push({ fact: { subject: subj, predicate: p.name, object: { text: String(val) } } });
        }
      }
      continue;
    }

    // shape B: source is a link/relationship table
    const linkT = tableOf(schema, src);
    const linkRows = data[src] ?? [];
    if (!linkT || !toIsEntity) {
      gap("source_unresolved", { pred: p.name, src }, `predicate "${p.name}" source "${src}" not resolvable as a link table — skipped`);
      continue;
    }
    const toTable = tableOfType[p.to]!;
    const fkFrom = fkTo(linkT, fromTable);
    const fkToCol = fkTo(linkT, toTable);
    if (!fkFrom || !fkToCol) {
      gap("no_fk", { pred: p.name, src }, `predicate "${p.name}" could not find FK columns on ${src} → skipped`);
      continue;
    }
    for (const row of linkRows) {
      const subj = gid(p.from, row[fkFrom]);
      const obj = gid(p.to, row[fkToCol]);
      if (subj != null && obj != null) emitFact(subj, obj, row);
    }
  }

  return { items, idMap, typeOf, gaps };
}
