// Authoring routes: source picker, the shared type layer + per-source mappings, LLM propose/confirm,
// apply (transform → ingest → payoff), derived relations, and evaluate. All behind the auth gate.

import express from "express";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { parseSchema } from "../schema.ts";
import { proposeMapping } from "../propose.ts";
import { proposeDerived, composeDerived } from "../proposeDerived.ts";
import { transform } from "../transform.ts";
import type { TransformResult } from "../transform.ts";
import { Stroma } from "../stroma.ts";
import { planPayoff, runPayoff } from "../payoff.ts";
import { checkDerivedPath, evaluateDerived } from "../deriveEval.ts";
import { suppressedOf, type IngestStats } from "../etl/sink.ts";
import { loadConfig, recordRun, saveConfig } from "../etl/store.ts";
import { additionsOf, appendToModel, bindingsOf, composeMapping, conflictsOf, mappingCorrections, type ModelAdditions } from "../model.ts";
import { hash48 } from "../gdrive.ts";
import { recordDecision } from "../review-records.ts";
import type { DerivedRelation, Mapping } from "../types.ts";
import { sink } from "../runtime.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = resolve(HERE, "../../sources");
const DEFAULT_ID = "hr-sample"; // the source shown first / used when a request omits schema/data

export const modelRouter = express.Router();

type Rows = Record<string, Array<Record<string, unknown>>>;
interface Source {
  id: string;
  label: string;
  schema: string;
  data: string;
}

// Sources are pluggable: every sources/<id>.json ({label,schema,data}) is registered, no code change.
function loadSources(): Source[] {
  if (!existsSync(SOURCES_DIR)) return [];
  const out: Source[] = [];
  for (const f of readdirSync(SOURCES_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(resolve(SOURCES_DIR, f), "utf8")) as {
        label?: string;
        schema?: string;
        data?: unknown;
      };
      if (typeof j.schema !== "string") continue;
      out.push({
        id: basename(f, ".json"),
        label: j.label ?? basename(f, ".json"),
        schema: j.schema,
        data: typeof j.data === "string" ? j.data : JSON.stringify(j.data ?? {}, null, 2),
      });
    } catch {
      // skip a malformed source file rather than crash the server
    }
  }
  // default source first, then the rest alphabetically
  return out.sort((a, b) => (a.id === DEFAULT_ID ? -1 : b.id === DEFAULT_ID ? 1 : a.id.localeCompare(b.id)));
}

const sources = (): Source[] => loadSources();
const sourceById = (id?: string): Source => {
  const all = sources();
  return all.find((s) => s.id === id) ?? all.find((s) => s.id === DEFAULT_ID) ?? all[0]!;
};
const defaultSource = () => sourceById(DEFAULT_ID);

// global node id → a display name (row.name, falling back to the pk) — for the payoff ranking and the
// derived-relation "Try it" panel. Node ids are deterministic for the same mapping+data, so this map
// lines up with the ids in the live graph loaded by /api/apply.
function buildLabels(tr: TransformResult, data: Rows): Record<number, string> {
  const label: Record<number, string> = {};
  for (const [table, gtype] of Object.entries(tr.typeOf)) {
    for (const row of data[table] ?? []) {
      const g = tr.idMap[gtype]?.[String(row.id)];
      if (g != null) label[g] = String(row.name ?? row.id);
    }
  }
  return label;
}

// list registered sources (built-in + plugins) for the picker
modelRouter.get("/api/sources", (_req, res) => {
  res.json({ sources: sources().map((s) => ({ id: s.id, label: s.label })) });
});

// one source's schema + data (defaults to the built-in when no/unknown id)
modelRouter.get("/api/source", (req, res) => {
  const s = sourceById(req.query.id as string | undefined);
  res.json({ id: s.id, label: s.label, schema: s.schema, data: s.data });
});

// The model split, read side: the shared type layer (ONE per deployment) + every per-source mapping.
modelRouter.get("/api/model", (_req, res) => {
  const cfg = loadConfig();
  res.json({ model: cfg.model, mappings: cfg.mappings });
});

// Set (or clear, with null) a predicate's sensitivity floor — the minimum access label facts/claims
// of that predicate get, whatever their source's own sharing state derived. Automatic assignment only
// ever RAISES a label above its source-derived tier; this endpoint is the one explicit human edit
// that can also lower or remove a floor.
modelRouter.post("/api/model/sensitivity", (req, res) => {
  const name = typeof req.body?.predicate === "string" ? req.body.predicate.trim() : "";
  const raw = req.body?.sensitivity;
  if (!name) return res.status(400).json({ error: "missing predicate" });
  if (raw !== null && !(Number.isInteger(raw) && raw >= 1 && raw <= 255)) {
    return res.status(400).json({ error: "sensitivity must be an integer label (1-255) or null to clear" });
  }
  const cfg = loadConfig();
  if (!cfg.model.predicates.some((p) => p.name === name)) {
    return res.status(404).json({ error: `predicate "${name}" is not in the shared type layer` });
  }
  const saved = saveConfig((c) => {
    const p = c.model.predicates.find((x) => x.name === name);
    if (!p) return;
    if (raw === null) delete p.sensitivity;
    else p.sensitivity = raw;
  });
  console.log(`  /api/model/sensitivity → "${name}": ${raw === null ? "cleared" : raw}`);
  res.json({ ok: true, predicate: saved.model.predicates.find((p) => p.name === name) });
});

// Confirm a proposal into the two persisted layers: append the mapping's NEW types/predicates to the
// shared layer and save the per-source bindings under sourceId. A redefinition of an existing
// predicate (different cardinality/domain/range) is rejected — cardinality is load-bearing in the
// engine, so the shared layer never silently changes meaning under other sources. `additions`, when
// sent, is the explicit approval list: a new declaration the mapping needs but the list omits is an
// error rather than a silent append.
modelRouter.post("/api/model/confirm", (req, res) => {
  const sourceId = typeof req.body?.sourceId === "string" ? req.body.sourceId.trim() : "";
  const mapping = req.body?.mapping as Mapping | undefined;
  if (!sourceId) return res.status(400).json({ error: "missing sourceId" });
  if (!mapping?.entity_types || !Array.isArray(mapping.predicates)) {
    return res.status(400).json({ error: "missing mapping (entity_types + predicates)" });
  }
  const conflicts = conflictsOf(loadConfig().model, mapping);
  if (conflicts.length) return res.status(409).json({ error: `rejected — ${conflicts.join("; ")}`, conflicts });
  const needed = additionsOf(loadConfig().model, mapping);
  const approved = req.body?.additions as Partial<ModelAdditions> | undefined;
  if (approved) {
    const missing = [
      ...needed.types.filter((t) => !(approved.types ?? []).includes(t)).map((t) => `type "${t}"`),
      ...needed.predicates.filter((p) => !(approved.predicates ?? []).includes(p)).map((p) => `predicate "${p}"`),
    ];
    if (missing.length) {
      return res.status(400).json({ error: `mapping needs new declarations not in additions: ${missing.join(", ")}`, needed });
    }
  }
  let added: ModelAdditions = { types: [], predicates: [] };
  const cfg = saveConfig((c) => {
    added = appendToModel(c.model, mapping);
    c.mappings[sourceId] = bindingsOf(mapping);
  });
  console.log(`  /api/model/confirm → "${sourceId}": +${added.types.length} types, +${added.predicates.length} predicates`);
  res.json({ ok: true, added, model: cfg.model, mapping: cfg.mappings[sourceId] });
});

// Cache proposals by (shared layer + schema text): an LLM call is one-time per source (not per
// page-load / re-open / language switch), and a shared-layer change invalidates every cached proposal
// (it was proposed against the old layer). "Re-propose" (fresh=true) forces a new call.
const proposeCache = new Map<string, { tables: unknown; mapping: Mapping; model: unknown; additions: ModelAdditions }>();

modelRouter.post("/api/propose", async (req, res) => {
  try {
    const schemaText = (req.body?.schema as string | undefined) ?? defaultSource().schema;
    const fresh = req.body?.fresh === true;
    const model = loadConfig().model;
    const cacheKey = `${JSON.stringify(model)}\n${schemaText}`;
    if (!fresh) {
      const hit = proposeCache.get(cacheKey);
      if (hit) {
        console.log("  /api/propose → cache hit (no LLM call)");
        return res.json(hit);
      }
    }
    const schema = parseSchema(schemaText);
    if (!schema.tables.length) return res.status(400).json({ error: "no tables found in the schema DDL" });
    console.log(`  /api/propose → LLM call${fresh ? " (forced re-propose)" : ""}`);
    const mapping = await proposeMapping(schema, model);
    // additive over the wizard's { tables, mapping } contract: the layer proposed against, and which
    // of the proposal's declarations would be NEW to it (diffed here, not taken on the LLM's word)
    const result = {
      tables: schema.tables.map((t) => ({ name: t.name, isJoin: t.isJoin, joins: t.joins })),
      mapping,
      model,
      additions: additionsOf(model, mapping),
    };
    proposeCache.set(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

modelRouter.post("/api/apply", async (req, res) => {
  try {
    // An inline mapping (the wizard flow) is used as-is and NOT persisted — persisting is the explicit
    // /api/model/confirm. When the request instead names a sourceId with a saved mapping, that mapping
    // is composed with the shared layer and applied.
    const sourceId = typeof req.body?.sourceId === "string" ? req.body.sourceId.trim() : "";
    let mapping = req.body?.mapping as Mapping | undefined;
    if (!mapping && sourceId) {
      const cfg = loadConfig();
      const saved = cfg.mappings[sourceId];
      if (!saved) return res.status(400).json({ error: `no saved mapping for source "${sourceId}" — confirm one via /api/model/confirm` });
      mapping = composeMapping(cfg.model, saved);
    }
    if (!mapping) return res.status(400).json({ error: "missing mapping" });
    const fallback = sourceId ? sourceById(sourceId) : defaultSource();
    const schema = parseSchema((req.body?.schema as string | undefined) ?? fallback.schema);
    let data: Rows;
    try {
      data = JSON.parse((req.body?.data as string | undefined) ?? fallback.data) as Rows;
    } catch (e) {
      return res.status(400).json({ error: `sample data is not valid JSON: ${(e as Error).message}` });
    }

    const tr = transform(schema, mapping, data);

    if (!(await sink.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    // Incremental load: apply never wipes the graph (other pipelines feed the same one). Node ids are
    // deterministic per source, so re-applying the same data converges instead of duplicating. A full
    // wipe is the explicit admin action POST /api/sink/reset. Each apply is a one-shot run in the
    // store's history: source rows in, facts out, stamped with provenance "apply" by the sink.
    const startedAt = Date.now();
    const events = Object.values(data).reduce((n, rows) => n + rows.length, 0);
    const facts = tr.items.filter((item) => "fact" in item).length;
    let stats: IngestStats;
    try {
      stats = await sink.ingest(tr.items, { pipelineId: "apply" });
    } catch (e) {
      recordRun({ pipelineId: "apply", kind: "one-shot", startedAt, finishedAt: Date.now(), events, facts: 0, error: (e as Error).message });
      throw e;
    }
    recordRun({ pipelineId: "apply", kind: "one-shot", startedAt, finishedAt: Date.now(), events, facts, suppressed: suppressedOf(stats), error: null });

    // The wizard sends the untouched LLM proposal alongside the mapping the human applied — the
    // proposed-vs-confirmed delta is a review decision worth keeping (what did the human have to
    // fix?), so it lands as a ReviewRecord. Keyed by the source schema: re-applying the same
    // source appends a new decision instance, never supersedes.
    const proposed = req.body?.proposed as Mapping | undefined;
    if (proposed && req.body?.mapping) {
      const corrections = mappingCorrections(proposed, mapping);
      await recordDecision(sink, {
        surface: "wizard",
        key: `s${hash48(schema.tables.map((t) => t.name).join(",")).toString(16)}`,
        decision: corrections.length ? "corrected" : "confirmed",
        proposal: `ontology mapping: ${mapping.predicates.length} predicates over ${Object.keys(mapping.entity_types).length} tables`,
        evidence: corrections.length ? corrections.join("; ") : "applied as proposed",
        at: Math.floor(Date.now() / 1000),
      });
    }

    const out: Record<string, unknown> = { stats, gaps: tr.gaps };

    const plan = planPayoff(mapping);
    if ("error" in plan) {
      out.payoff = { error: plan.error };
      return res.json(out);
    }
    const projects = data["projects"] ?? [];
    const target = projects.find((r) => String(r.name).includes("ML Recommender")) ?? projects[0];
    const targetGid = tr.idMap[plan.projectType]?.[String(target?.id)];
    if (targetGid == null) {
      out.payoff = { error: "no target project in the graph to staff" };
      return res.json(out);
    }
    const label = buildLabels(tr, data);
    const db = new Stroma(); // payoff reads (expand) — read paths stay on the raw client
    await db.ensureAuthed(); // API token if STROMA_API_TOKEN is set, else session login
    const needs = (await db.expand(targetGid, plan.needsPred)).map((g) => label[g] ?? `#${g}`);
    const ranking = await runPayoff(db, tr, plan, targetGid, (g) => label[g] ?? `#${g}`);
    out.payoff = { project: String(target?.name), needs, ranking };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Suggest DERIVED relations (named 2-hop compositions over the confirmed base predicates), evaluated
// on read rather than stored. LLM path is best-effort; a mechanical composer is the graceful fallback.
// Every candidate is type-checked against the mapping before it is returned, so a bad path is dropped.
const derivedCache = new Map<string, { derived: DerivedRelation[]; source: string }>();

modelRouter.post("/api/propose-derived", async (req, res) => {
  try {
    const mapping = req.body?.mapping as Mapping | undefined;
    if (!mapping || !Array.isArray(mapping.predicates)) return res.status(400).json({ error: "missing mapping.predicates" });
    const fresh = req.body?.fresh === true;
    const cacheKey = JSON.stringify(mapping.predicates.map((p) => [p.name, p.from, p.to, p.cardinality]));
    if (!fresh) {
      const hit = derivedCache.get(cacheKey);
      if (hit) return res.json(hit);
    }
    const fromLlm = await proposeDerived(mapping);
    const candidates = fromLlm.length ? fromLlm : composeDerived(mapping);
    // keep only paths that mechanically compose; dedupe by name
    const seen = new Set<string>();
    const derived = candidates.filter((r) => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return checkDerivedPath(mapping, r).length === 0;
    });
    const result = { derived, source: fromLlm.length ? "llm" : "mechanical" };
    derivedCache.set(cacheKey, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Evaluate a derived relation from a subject over the LIVE graph — chaining point/expand, never a
// stored edge. Returns candidate subjects (of the relation's from-type) so the UI can offer a picker,
// plus the evaluated result and a per-hop trace. `asOf` (a YYYYMMDD instant) reads valid-time as-of.
async function handleEvaluate(req: express.Request, res: express.Response): Promise<void> {
  try {
    // POST carries JSON in the body; GET carries JSON-encoded rule/mapping in the query string.
    const q = req.query as Record<string, string | undefined>;
    const parse = (v: string | undefined) => (v ? JSON.parse(v) : undefined);
    const rule = (req.body?.rule as DerivedRelation | undefined) ?? (parse(q.rule) as DerivedRelation | undefined);
    const mapping = (req.body?.mapping as Mapping | undefined) ?? (parse(q.mapping) as Mapping | undefined);
    const asOfRaw = req.body?.asOf ?? q.asOf;
    const asOf = asOfRaw == null || asOfRaw === "" ? undefined : Number(asOfRaw);
    const subjRaw = req.body?.subject ?? q.subject;
    if (!rule || !mapping) {
      res.status(400).json({ error: "missing rule or mapping" });
      return;
    }
    const typeErrors = checkDerivedPath(mapping, rule);
    if (typeErrors.length) {
      res.status(400).json({ error: "derived path does not compose", typeErrors });
      return;
    }

    const schema = parseSchema((req.body?.schema as string | undefined) ?? (q.schema as string | undefined) ?? defaultSource().schema);
    let data: Rows;
    try {
      data = JSON.parse((req.body?.data as string | undefined) ?? (q.data as string | undefined) ?? defaultSource().data) as Rows;
    } catch (e) {
      res.status(400).json({ error: `sample data is not valid JSON: ${(e as Error).message}` });
      return;
    }

    const tr = transform(schema, mapping, data);
    const label = buildLabels(tr, data);
    const named = (id: number) => ({ id, label: label[id] ?? `#${id}` });
    const subjects = Object.values(tr.idMap[rule.from] ?? {}).sort((a, b) => a - b).map(named);

    const db = new Stroma();
    if (!(await db.health())) {
      res.json({ reachable: false, subjects, asOf: asOf ?? null });
      return;
    }
    await db.ensureAuthed();

    const subject = subjRaw != null && subjRaw !== "" ? Number(subjRaw) : subjects[0]?.id;
    if (subject == null) {
      res.json({ reachable: true, subjects, asOf: asOf ?? null, result: [], one: null, steps: [] });
      return;
    }

    const evalResult = await evaluateDerived(db, mapping, rule, subject, asOf);
    res.json({
      reachable: true,
      subjects,
      subject: named(subject),
      asOf: evalResult.asOf,
      cardinality: evalResult.cardinality,
      result: evalResult.result.map(named),
      one: evalResult.one != null ? named(evalResult.one) : null,
      steps: evalResult.steps.map((s) => ({ predicate: s.predicate, direction: s.direction, op: s.op, reached: s.reached.map(named) })),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
modelRouter.post("/api/evaluate", handleEvaluate);
modelRouter.get("/api/evaluate", handleEvaluate);
