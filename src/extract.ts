// The unstructured on-ramp: text → LLM extraction → typed facts.
//
// A structured source has a schema the LLM maps once. A document has none — so the human confirms an
// EXTRACTION PATTERN (which entity types + predicates to pull), and the LLM applies it to each
// document at ingest. This is not delegable to an off-the-shelf ELT connector (those move rows, not typed facts).
// One extractor serves every document type. Output is typed facts stamped with their source document
// (provenance) — kept distinct from asserted facts, since extraction is lossy.

import { callLLM, extractJson } from "./llm.ts";

/** The confirmed extraction pattern: the target ontology the extractor pulls into. Authored/confirmed
 *  once (the unstructured analogue of the wizard's mapping), then applied to every document. */
export interface Pattern {
  entity_types: string[];
  predicates: Array<{
    name: string;
    from: string;
    to: string;
    kind: "edge" | "value";
    card: "one" | "many";
    /** this predicate's text value labels its subject node in the engine's graph views */
    display?: boolean;
  }>;
}

export interface ExtractedFact {
  subject: string; // entity name (resolved to a node later)
  subjectType: string;
  predicate: string;
  object: string; // entity name (edge) or literal (value)
  objectType?: string; // set for edge predicates
  source: string; // provenance: the document id this was extracted from
}

function patternForPrompt(p: Pattern): string {
  const preds = p.predicates
    .map((x) => `  - ${x.name}: ${x.from} → ${x.to}${x.kind === "value" ? " (a value)" : " (a link to another entity)"}`)
    .join("\n");
  return `Entity types: ${p.entity_types.join(", ")}\nRelationships to extract:\n${preds}`;
}

const INSTRUCTIONS = `You extract structured facts from an internal document. You are given a fixed
list of entity types and relationships (the extraction pattern). Extract ONLY facts that match one of
the listed relationships. Use the exact names as written in the document for entities (a person's
name, a team name). Do not invent facts that aren't supported by the text. If the document says
nothing about a relationship, omit it.

Output ONLY a JSON object:
{
  "facts": [
    { "subject": "<entity name>", "subjectType": "<one of the entity types>",
      "predicate": "<one of the relationship names>",
      "object": "<entity name or value>", "objectType": "<entity type, omit for a value>" }
  ]
}`;

export function buildPrompt(pattern: Pattern, docText: string): string {
  return `${INSTRUCTIONS}\n\nEXTRACTION PATTERN:\n${patternForPrompt(pattern)}\n\nDOCUMENT:\n"""\n${docText}\n"""\n`;
}

/** Extract typed facts from one document, stamped with its source id (provenance). */
export async function extractFacts(pattern: Pattern, docId: string, docText: string): Promise<ExtractedFact[]> {
  const text = await callLLM(buildPrompt(pattern, docText));
  const obj = extractJson(text) as { facts?: Array<Record<string, string | undefined>> };
  const valuePreds = new Set(pattern.predicates.filter((p) => p.kind === "value").map((p) => p.name));
  const out: ExtractedFact[] = [];
  for (const f of obj.facts ?? []) {
    if (!f.subject || !f.predicate || !f.object) continue;
    out.push({
      subject: f.subject,
      subjectType: f.subjectType ?? "",
      predicate: f.predicate,
      object: f.object,
      objectType: valuePreds.has(f.predicate) ? undefined : f.objectType,
      source: docId,
    });
  }
  return out;
}
