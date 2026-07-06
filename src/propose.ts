// Given ONLY the source schema, an LLM proposes a graph ontology + mapping.
// A human later confirms the proposal in plain language; this is the un-simulated proposer — the test
// of whether "AI proposes the structure" actually holds, rather than being hand-waved.

import type { Mapping, SchemaModel } from "./types.ts";
import { callLLM, extractJson } from "./llm.ts";

function schemaForPrompt(schema: SchemaModel): string {
  return schema.tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const bits = [c.name, c.type.toLowerCase()];
          if (c.pk) bits.push("pk");
          if (c.ref) bits.push(`→ ${c.ref}`);
          return `    ${bits.join(" ")}`;
        })
        .join("\n");
      const tag = t.isJoin ? `  (link table between ${t.joins?.join(" and ")})` : "";
      return `  ${t.name}${tag}\n${cols}`;
    })
    .join("\n");
}

const INSTRUCTIONS = `You are the mapping assistant in a no-code tool. A domain expert (NOT a data modeler)
will later confirm your proposal in plain language. Read the source database schema and propose how to
turn it into a typed knowledge graph, so that downstream questions like "who is a good fit to staff a
project that needs certain skills, and who is actually available" can be answered.

Decide, on your own, the structure that makes such queries work:
- Which tables are ENTITY TYPES (things) vs which are RELATIONSHIPS (links between things).
- Promote a value to its own entity when more than one thing points at it (so it can be shared and
  queried across), rather than leaving it as a text attribute.
- Link tables (many-to-many, or a table that mainly connects two others) are relationships, not things.
- Give each relationship a cardinality: "one" or "many".
- Keep meaningful EDGE ATTRIBUTES on the relationship (e.g. a strength/level, a role, an allocation
  percentage) via "properties".
- If a relationship has an end-date column where NULL means "still current", record that column as
  "valid_end" so "who is on it NOW" stays answerable.
- A free-text table with no meaningful links can be left out of entity_types (set aside as searchable
  text).

Output ONLY a JSON object, no prose, in exactly this shape:
{
  "entity_types": { "<source_table>": "<GraphTypeName>", ... },
  "predicates": [
    { "name": "<kebab-name>", "source": "<table or table.column>", "from": "<GraphType>",
      "to": "<GraphType>", "cardinality": "one|many",
      "properties": ["<col>", ...],        // optional, omit if none
      "valid_end": "<col>" }               // optional, omit if none
  ],
  "rationale": { "<predicate-name or type:<table>>": "<one plain-language sentence>", ... }
}`;

export function buildPrompt(schema: SchemaModel): string {
  return `${INSTRUCTIONS}\n\nSOURCE SCHEMA:\n${schemaForPrompt(schema)}\n`;
}

export async function proposeMapping(schema: SchemaModel): Promise<Mapping> {
  const text = await callLLM(buildPrompt(schema));
  const obj = extractJson(text) as Mapping;
  if (!obj.entity_types || !Array.isArray(obj.predicates)) {
    throw new Error("LLM proposal missing entity_types/predicates");
  }
  return obj;
}
