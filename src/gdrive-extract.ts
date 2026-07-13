// The Drive BODY lane: curated one-shot extraction of document content into typed claims.
//
// Bodies never ride the poll — one LLM call per document is the expensive, lossy layer, so it runs
// only as an explicitly triggered one-shot over a human-curated selection:
//
//   1. classifyFiles   — triage a scope listing into readable (PDF, Google Doc) vs skipped (counted
//                        per mimeType, never silently dropped), with a filename heuristic flagging
//                        likely drafts (pre-deselected client-side, still listed).
//   2. extractClaims   — apply the extraction pattern with ONE LLM call per document. PDFs go to the
//                        model natively (no parser dependency, no conversion layer); Google Docs go
//                        as exported plain text.
//   3. claimsToBatch   — deterministic mapping to a self-contained ingest batch: pattern defs +
//                        entity nodes in the extracted-entity band + facts with explicit
//                        `drive:<fileId>` provenance on every fact.
//
// Node ids: extracted entities are named in prose, not keyed by a Drive id, so they mint in their
// own band — 8·2^48, one above gdrive.ts's Document/Folder/Person bands (see the band table there)
// — as hash48("<docFileId>|<entityType>|<entityName>"). Scoping the hash by source document keeps
// re-reading a file idempotent (same names → same ids, facts supersede in place) without same-name
// entities from unrelated documents silently merging; cross-document resolution stays a later,
// explicit step.
//
// Labels: every extracted node gets max(source document's ACL-derived sensitivity tier, the
// sensitivity floor of each predicate it appears in — model.ts sensitivityFloor) — the ratchet:
// a floor can only raise a label above the document's tier, never lower it.
//
// valid_from: when the pattern declares a date field and the model returned an ISO effective date
// for a claim (e.g. a regulation's stated effective date), that date's epoch; otherwise the file's
// modifiedTime — so rule documents become as-of readable.

import type { BatchItem, FactObject } from "./etl/types.ts";
import type { Pattern } from "./extract.ts";
import { isoToEpoch } from "./backlog.ts";
import { DOC_MIME, PDF_MIME, SLIDES_MIME, type DriveFile } from "./gdrive-api.ts";
import { hash48, nid, sensitivityLabel } from "./gdrive.ts";
import { callLLM, extractJson } from "./llm.ts";
import { sensitivityFloor, type SharedModel } from "./model.ts";

// --- pattern -------------------------------------------------------------------------------------

/** The body lane's extraction pattern: the shared Pattern plus an optional date field. When set,
 *  the extractor asks the model for an ISO effective date per claim (only when the document states
 *  one), and claims that carry it get valid_from = that date's epoch. */
export interface DocPattern extends Pattern {
  date_field?: string;
}

/** The default pattern for regulation-type documents — human-editable per request (v1: the API
 *  request body carries the pattern; this is the fallback when it doesn't). */
export const DEFAULT_PATTERN: DocPattern = {
  entity_types: ["Rule", "Section"],
  predicates: [
    { name: "rule-title", from: "Rule", to: "text", kind: "value", card: "one", display: true },
    { name: "rule-text", from: "Rule", to: "text", kind: "value", card: "one" },
    { name: "applies-to", from: "Rule", to: "text", kind: "value", card: "one" },
    { name: "in-section", from: "Rule", to: "Section", kind: "edge", card: "one" },
  ],
  date_field: "effective-from",
};

// --- funnel classification -------------------------------------------------------------------------

/** One curation-funnel entry: a readable file with everything the human needs to confirm it. */
export interface FunnelFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  /** the document's ACL-derived sensitivity tier (gdrive.ts sensitivityLabel) */
  label: number;
  /** filename draft heuristic — pre-deselected client-side, still listed */
  draft: boolean;
}

/** Filenames that usually mean "not the document of record" (incl. localized markers). */
export const DRAFT_RE = /draft|下書き|案|copy|コピー|old|_v\d+|backup/i;

/** Triage hydrated files: PDFs, Google Docs and Slides are readable; everything else is counted
 *  per mimeType — skipped files are summarized, never silently dropped. */
export function classifyFiles(files: DriveFile[]): { files: FunnelFile[]; skipped: Record<string, number> } {
  const readable: FunnelFile[] = [];
  const skipped: Record<string, number> = {};
  for (const f of files) {
    const mime = f.mimeType ?? "unknown";
    if (mime === PDF_MIME || mime === DOC_MIME || mime === SLIDES_MIME) {
      const name = f.name ?? f.id;
      readable.push({
        id: f.id,
        name,
        mimeType: mime,
        modifiedTime: f.modifiedTime,
        label: sensitivityLabel(f.permissions),
        draft: DRAFT_RE.test(name),
      });
    } else {
      skipped[mime] = (skipped[mime] ?? 0) + 1;
    }
  }
  return { files: readable, skipped };
}

// --- extraction (one LLM call per document) --------------------------------------------------------

/** What one document's body looks like to the extractor: exported text (Google Doc) or native
 *  PDF bytes (base64) handed to the model as an attachment. */
export type DocContent = { kind: "text"; text: string } | { kind: "pdf"; base64: string };

/** One extracted claim — a typed fact candidate, pre-resolution. `effectiveFrom` is the ISO date the
 *  document states the claim takes effect (only when the pattern declares a date field). */
export interface DocClaim {
  subject: string;
  subjectType: string;
  predicate: string;
  object: string;
  objectType?: string;
  effectiveFrom?: string;
}

function patternForPrompt(p: DocPattern): string {
  const preds = p.predicates
    .map((x) => `  - ${x.name}: ${x.from} → ${x.to}${x.kind === "value" ? " (a value)" : " (a link to another entity)"}`)
    .join("\n");
  return `Entity types: ${p.entity_types.join(", ")}\nRelationships to extract:\n${preds}`;
}

const INSTRUCTIONS = `You extract structured claims from an internal document (a regulation, policy,
or similar rule document). You are given a fixed list of entity types and relationships (the
extraction pattern). Extract ONLY facts that match one of the listed relationships. Use the exact
names/identifiers as written in the document for entities (a rule number, a section heading). Do not
invent facts that are not supported by the document. If the document says nothing about a
relationship, omit it.`;

function outputSpec(dateField: string | undefined): string {
  const eff = dateField
    ? `,\n      "effectiveFrom": "<ISO date YYYY-MM-DD — only when the document states the date this claim takes effect>"`
    : "";
  return `Output ONLY a JSON object:
{
  "facts": [
    { "subject": "<entity name>", "subjectType": "<one of the entity types>",
      "predicate": "<one of the relationship names>",
      "object": "<entity name or value>", "objectType": "<entity type, omit for a value>"${eff} }
  ]
}`;
}

export function buildDocPrompt(pattern: DocPattern, doc: DocContent): string {
  const date = pattern.date_field
    ? `\nThe pattern declares a date field ("${pattern.date_field}"): when the document states the date a
rule takes effect (e.g. "effective April 1, 2026"), set "effectiveFrom" on every fact governed by
that date, as an ISO date. Omit it when the document states none.\n`
    : "";
  const body = doc.kind === "text" ? `DOCUMENT:\n"""\n${doc.text}\n"""` : "The DOCUMENT is the attached PDF.";
  return `${INSTRUCTIONS}\n${date}\n${outputSpec(pattern.date_field)}\n\nEXTRACTION PATTERN:\n${patternForPrompt(pattern)}\n\n${body}\n`;
}

/** Model output → claims, dropping anything outside the pattern. Missing subject/object types
 *  default to the predicate's declared domain/range. */
export function parseClaims(text: string, pattern: DocPattern): DocClaim[] {
  const obj = extractJson(text) as { facts?: Array<Record<string, unknown>> };
  const predByName = new Map(pattern.predicates.map((p) => [p.name, p]));
  const out: DocClaim[] = [];
  for (const f of obj.facts ?? []) {
    const subject = typeof f.subject === "string" ? f.subject.trim() : "";
    const predicate = typeof f.predicate === "string" ? f.predicate : "";
    const object = typeof f.object === "string" ? f.object.trim() : "";
    const decl = predByName.get(predicate);
    if (!subject || !object || !decl) continue; // outside the pattern → dropped, never ingested
    const claim: DocClaim = {
      subject,
      subjectType: typeof f.subjectType === "string" && f.subjectType ? f.subjectType : decl.from,
      predicate,
      object,
    };
    if (decl.kind === "edge") {
      claim.objectType = typeof f.objectType === "string" && f.objectType ? f.objectType : decl.to;
    }
    if (typeof f.effectiveFrom === "string" && f.effectiveFrom.trim()) claim.effectiveFrom = f.effectiveFrom.trim();
    out.push(claim);
  }
  return out;
}

/** ONE LLM call for one document: text inline, PDFs as a native attachment (llm.ts decides the
 *  transport — API document block, or a temp file for the CLI dev harness). */
export async function extractClaims(pattern: DocPattern, doc: DocContent): Promise<DocClaim[]> {
  const text = await callLLM(buildDocPrompt(pattern, doc), {
    timeoutMs: 240_000,
    maxTokens: 4096,
    pdfBase64: doc.kind === "pdf" ? doc.base64 : undefined,
  });
  return parseClaims(text, pattern);
}

// --- claims → ingest batch --------------------------------------------------------------------------

/** The extracted-entity band: one above gdrive.ts's Document/Folder/Person bands. */
export const CLAIM_BAND = 8 * 2 ** 48;

/** Deterministic extracted-entity id: hash48 of "<docKey>|<entityType>|<entityName>" in the claim
 *  band — idempotent per LOGICAL document, never colliding across bands. The key defaults to the
 *  file id; revisions of the same policy pass a shared logical id so the same provision extracted
 *  from two revisions lands on ONE node and effective-date supersession builds a timeline. */
export const claimNid = (docKey: string, entityType: string, entityName: string): number =>
  CLAIM_BAND + hash48(`${docKey}|${entityType}|${entityName}`);

export interface ClaimBatch {
  items: BatchItem[];
  factCount: number;
  entityCount: number;
  /** the declared policy requirement stamped on the Document node, when any claim predicate has a floor */
  requiresFloor: number | null;
}

/** Map one document's claims to a self-contained ingest batch (pattern defs + nodes + facts).
 *  Every fact carries source `drive:<fileId>` EXPLICITLY — the sink's pipeline-id stamp only fills
 *  unset sources, and these must trace to the document, not the lane. */
export function claimsToBatch(input: {
  fileId: string;
  /** claim-identity key shared by revisions of the same policy — defaults to fileId */
  logicalDocId?: string;
  /** the source document's ACL-derived sensitivity tier */
  docLabel: number;
  /** the valid_from fallback for claims without an effective date */
  modifiedTime?: string;
  pattern: DocPattern;
  claims: DocClaim[];
  model: SharedModel;
}): ClaimBatch {
  const { fileId, docLabel, pattern, claims, model } = input;
  // provenance stays the ACTUAL file (which revision said it); only claim identity uses the logical key
  const docKey = input.logicalDocId ?? fileId;
  const source = `drive:${fileId}`;
  const docEpoch = isoToEpoch(input.modifiedTime ?? "");

  // Pattern defs ride every batch (idempotent in the engine), so a batch is self-contained.
  const defs: BatchItem[] = [
    ...pattern.entity_types.map((t): BatchItem => ({ type_def: { name: t } })),
    ...pattern.predicates.map(
      (p): BatchItem => ({
        pred_def:
          p.kind === "value"
            ? { name: p.name, cardinality: p.card, domain: p.from, range_value: "text", display: p.display }
            : { name: p.name, cardinality: p.card, domain: p.from, range: p.to, display: p.display },
      }),
    ),
  ];

  const types = new Set(pattern.entity_types);
  const nodeType = new Map<number, string>();
  const nodeLabel = new Map<number, number>();
  const facts: BatchItem[] = [];
  let maxFloor = 0;

  const entity = (type: string, name: string, label: number): number | null => {
    if (!types.has(type)) return null; // a type outside the pattern never mints a node
    const id = claimNid(docKey, type, name);
    nodeType.set(id, type);
    nodeLabel.set(id, Math.max(nodeLabel.get(id) ?? 0, label));
    return id;
  };

  for (const c of claims) {
    const floor = sensitivityFloor(model, c.predicate) ?? 0;
    // label ratchet: at least the document's tier, raised further by the predicate's floor
    const label = Math.max(docLabel, floor);
    const subject = entity(c.subjectType, c.subject, label);
    if (subject == null) continue;
    let object: FactObject;
    if (c.objectType) {
      const obj = entity(c.objectType, c.object, label);
      if (obj == null) continue;
      object = { node: obj };
    } else {
      object = { text: c.object };
    }
    const eff = c.effectiveFrom ? isoToEpoch(c.effectiveFrom) : 0;
    facts.push({ fact: { subject, predicate: c.predicate, object, valid_from: eff > 0 ? eff : docEpoch, source } });
    if (floor > maxFloor) maxFloor = floor;
  }

  const nodes: BatchItem[] = [...nodeType.entries()].map(([id, type]): BatchItem => ({
    node: { id, type, label: nodeLabel.get(id)! },
  }));

  // Declared policy requirement on the SOURCE Document node (structural-lane id): the max
  // sensitivity floor over the ingested claims' predicates ALONE — deliberately NOT max'd with the
  // document's observed ACL tier, so a later evaluator can compare requirement vs observed label to
  // flag over-shared files. valid_from = the document's modifiedTime (the same instant the
  // structural lane stamps), so the requirement supersedes in step with the document itself.
  const requiresFloor = maxFloor > 0 ? maxFloor : null;
  const entityCount = nodes.length;
  if (requiresFloor != null) {
    defs.push({ pred_def: { name: "requires-floor", cardinality: "one", domain: "Document", range_value: "int" } });
    facts.push({
      fact: {
        subject: nid("Document", fileId),
        predicate: "requires-floor",
        object: { int: requiresFloor },
        valid_from: docEpoch,
        source,
      },
    });
  }

  return { items: [...defs, ...nodes, ...facts], factCount: facts.length, entityCount, requiresFloor };
}
