// Implicit-inference routes: deterministic document→project affinities proposed from grant
// neighborhoods (src/inferences.ts), and the human verdict on the ambiguous ones. Unanimous
// inferences are served as filled — evaluated per request, never stored. Confirm writes ONE
// relates-to-project fact (provenance inference-review); dismiss persists the (doc, project) pair
// in the config store — a rejected inference is not a fact we can assert. Every verdict also lands
// a ReviewRecord (proposal + support evidence + decision, provenance human-review).
// Mounted behind the session auth gate (server.ts).

import express from "express";
import { Stroma } from "../stroma.ts";
import { INFERENCE_REVIEW_ID, confirmedInferenceBatch, findInferences, type InferenceRow } from "../inferences.ts";
import { loadConfig, saveConfig } from "../etl/store.ts";
import { recordDecision } from "../review-records.ts";
import { sink } from "../runtime.ts";

export const inferencesRouter = express.Router();

const pairKey = (doc: number, project: number): string => `${doc}|${project}`;
const now = (): number => Math.floor(Date.now() / 1000);

/** One inference verdict → one ReviewRecord. The row (when it still infers) restates the
 *  neighborhood strength server-side; a verdict on one that no longer infers records ids only. */
async function recordInferenceDecision(input: {
  doc: number;
  project: number;
  row: InferenceRow | undefined;
  decision: "confirmed" | "dismissed";
  reviewer: string;
  note?: string;
}): Promise<void> {
  const { row } = input;
  await recordDecision(sink, {
    surface: "inferences",
    key: pairKey(input.doc, input.project),
    decision: input.decision,
    proposal: row
      ? `relates-to-project: ${row.doc.name ?? row.doc.id} → ${row.project.name ?? row.project.id}`
      : `relates-to-project: ${input.doc} → ${input.project}`,
    evidence: row ? `${row.support}/${row.resolvable} resolvable grantees active in the project` : undefined,
    reviewer: input.reviewer,
    note: input.note,
    at: now(),
    documents: [input.doc],
    persons: row?.supporters.map((x) => x.grantee.id),
  });
}

// GET /api/inferences/candidates → on-demand evaluation; nothing is cached or stored, the rows are
// re-derived from the graph every time (a grant change or a new same-as confirmation re-answers).
// `filled` = unanimous neighborhoods (auto-filled, no verdict to take); `candidates` = ambiguous
// majorities awaiting a human, dismissed ones marked, not hidden.
inferencesRouter.get("/api/inferences/candidates", async (_req, res) => {
  try {
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const dismissed = new Set(loadConfig().dismissedInferences ?? []);
    const rows = (await findInferences(db)).map((r) => ({ ...r, dismissed: dismissed.has(pairKey(r.doc.id, r.project.id)) }));
    const filled = rows.filter((r) => r.tier === "high");
    const candidates = rows
      .filter((r) => r.tier === "ambiguous")
      .sort((x, y) => Number(x.confirmed || x.dismissed) - Number(y.confirmed || y.dismissed) || y.support / y.resolvable - x.support / x.resolvable);
    res.json({ filled, candidates });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/inferences/resolve → { doc, project, decision: confirm|dismiss, reviewer?, note? }.
// Confirm re-derives the row (the evaluation IS the source of truth) and writes the ONE
// relates-to-project fact; a pair that no longer infers is a 404, not a silent write. Dismiss
// records the pair so it stops being proposed (config suppression survives an offline engine; the
// labelled-negative record lands when the engine is reachable).
inferencesRouter.post("/api/inferences/resolve", async (req, res) => {
  try {
    const doc = Number(req.body?.doc);
    const project = Number(req.body?.project);
    const decision = req.body?.decision as string | undefined;
    if (!Number.isInteger(doc) || !Number.isInteger(project) || !["confirm", "dismiss"].includes(decision ?? "")) {
      return res.status(400).json({ error: "expected { doc:int, project:int, decision: confirm|dismiss, reviewer?, note? }" });
    }
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const note = req.body?.note as string | undefined;
    if (decision === "dismiss") {
      saveConfig((cfg) => {
        const keys = cfg.dismissedInferences ?? [];
        if (!keys.includes(pairKey(doc, project))) keys.push(pairKey(doc, project));
        cfg.dismissedInferences = keys;
      });
      const db = new Stroma();
      if (await db.health()) {
        const row = (await findInferences(db)).find((r) => r.doc.id === doc && r.project.id === project);
        await recordInferenceDecision({ doc, project, row, decision: "dismissed", reviewer, note });
      } else {
        console.log(`inferences: engine offline — dismissal of ${doc}/${project} suppressed in config only, no ReviewRecord`);
      }
      return res.json({ ok: true, doc, project, decision });
    }
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const row = (await findInferences(db)).find((r) => r.doc.id === doc && r.project.id === project);
    if (!row) return res.status(404).json({ error: `no current inference for ${doc} → ${project} — the graph has moved, reload and re-review` });
    await sink.ingest(confirmedInferenceBatch(doc, project, now()), { pipelineId: INFERENCE_REVIEW_ID });
    await recordInferenceDecision({ doc, project, row, decision: "confirmed", reviewer, note });
    res.json({ ok: true, doc, project, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
