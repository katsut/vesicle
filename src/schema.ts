// Parse a Postgres `CREATE TABLE` DDL (the sample HR schema) into a SchemaModel.
// Deliberately small: handles the DDL subset the kit uses — column defs, inline PRIMARY KEY,
// REFERENCES, and composite `PRIMARY KEY (a, b)`. Comments (`-- ...`) are stripped.

import type { Column, SchemaModel, Table } from "./types.ts";

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

function parseTable(name: string, body: string): Table {
  const columns: Column[] = [];
  const compositePk: string[] = [];

  // split the parenthesised body on top-level commas
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);

  for (const raw of parts) {
    const clause = raw.trim().replace(/\s+/g, " ");
    if (!clause) continue;

    const pkTable = clause.match(/^PRIMARY KEY \(([^)]+)\)/i);
    if (pkTable) {
      for (const c of pkTable[1]!.split(",")) compositePk.push(c.trim());
      continue;
    }
    if (/^(FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(clause)) continue;

    const m = clause.match(/^(\w+)\s+(\w+)/);
    if (!m) continue;
    const colName = m[1]!;
    const type = m[2]!.toUpperCase();
    const pk = /PRIMARY KEY/i.test(clause);
    const refm = clause.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
    const ref = refm ? `${refm[1]}.${refm[2]}` : null;
    columns.push({ name: colName, type, pk, ref });
  }

  const pk = compositePk.length
    ? compositePk
    : columns.filter((c) => c.pk).map((c) => c.name);

  // join-table heuristic: composite pk of exactly two FK columns → a pure link table
  let isJoin = false;
  let joins: [string, string] | null = null;
  if (pk.length === 2) {
    const refs = pk
      .map((p) => columns.find((c) => c.name === p)?.ref)
      .filter((r): r is string => !!r)
      .map((r) => r.split(".")[0]!);
    if (refs.length === 2) {
      isJoin = true;
      joins = [refs[0]!, refs[1]!];
    }
  }
  // single-pk link tables (e.g. assignments: own id pk, but two FK columns + edge attrs)
  if (!isJoin) {
    const fkTables = columns
      .filter((c) => c.ref && !c.pk)
      .map((c) => c.ref!.split(".")[0]!);
    const distinct = [...new Set(fkTables)];
    if (distinct.length === 2 && !distinct.includes(name)) {
      isJoin = true;
      joins = [distinct[0]!, distinct[1]!];
    }
  }

  return { name, columns, pk, isJoin, joins };
}

export function parseSchema(sql: string): SchemaModel {
  const clean = stripComments(sql);
  const tables: Table[] = [];
  const re = /CREATE TABLE\s+(\w+)\s*\(([\s\S]*?)\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    tables.push(parseTable(m[1]!, m[2]!));
  }
  return { tables };
}
