// Given the source schema (and the deployment's shared type layer, when one exists), an LLM proposes
// a graph mapping. A human later confirms the proposal in plain language; this is the un-simulated
// proposer — the test of whether "AI proposes the structure" actually holds, rather than being
// hand-waved. With a shared layer in the prompt, the proposer maps onto EXISTING types/predicates
// where meanings match and only proposes new declarations when nothing fits.

import type { Mapping, SchemaModel } from "./types.ts";
import type { SharedModel } from "./model.ts";
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

function modelForPrompt(model: SharedModel): string {
  const types = model.types.map((t) => t.name).join(", ");
  const preds = model.predicates
    .map((p) => `    ${p.name}: ${p.domain} → ${p.range ?? `<${p.range_value ?? "text"} value>`} (${p.cardinality})`)
    .join("\n");
  return `  entity types: ${types}\n  predicates:\n${preds}`;
}

const REUSE = `This deployment already has a SHARED GRAPH MODEL (below): entity types and predicates that other
sources already feed, so that records from different systems land on the SAME entities (one shared
Person, not a Person per source).
- REUSE an existing type or predicate whenever a source table/field means the same thing: use the
  existing name EXACTLY, with the same domain, range and cardinality (e.g. a table of people maps to
  the existing Person type; a person's display-name column maps to the existing "name" predicate).
- Propose a NEW type or predicate ONLY when nothing existing fits. Never reuse an existing name for
  a different meaning, and never redefine an existing predicate's cardinality, domain or range.`;

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

export function buildPrompt(schema: SchemaModel, model?: SharedModel): string {
  const shared = model ? `\n\n${REUSE}\n\nSHARED GRAPH MODEL (already deployed):\n${modelForPrompt(model)}` : "";
  return `${INSTRUCTIONS}${shared}\n\nSOURCE SCHEMA:\n${schemaForPrompt(schema)}\n`;
}

/** Propose a mapping for `schema`. With `model`, the prompt carries the current shared type layer and
 *  the proposer is instructed to reuse its declarations; which parts are new is computed by diffing
 *  the result against the layer (model.ts additionsOf), never taken on the LLM's word. */
export async function proposeMapping(schema: SchemaModel, model?: SharedModel): Promise<Mapping> {
  const text = await callLLM(buildPrompt(schema, model));
  const obj = extractJson(text) as Mapping;
  if (!obj.entity_types || !Array.isArray(obj.predicates)) {
    throw new Error("LLM proposal missing entity_types/predicates");
  }
  return obj;
}
