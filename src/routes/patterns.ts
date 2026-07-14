// Pattern routes: mined rule candidates from event regularities (deterministic counts, human-
// confirmed), and the three-way verdict on each. Promote/risk write a MinedRule/RiskNote record
// through the guarded sink path with pattern-review provenance; dismiss only persists the patternId
// in the config store — a non-rule is not a fact we can assert. Mounted behind the session auth
// gate (server.ts).

import express from "express";
import { Stroma } from "../stroma.ts";
import { PATTERN_REVIEW_ID, findPatternCandidates, verdictBatch } from "../patterns.ts";
import { repairLateArrivals } from "../etl/guard.ts";
import { loadConfig, saveConfig } from "../etl/store.ts";
import { guardDb, logRepairs, sink } from "../runtime.ts";

export const patternsRouter = express.Router();

// GET /api/patterns/candidates → on-demand scan; nothing is cached, the counts are re-derived from
// the graph every time. Dismissed patterns are excluded (a dismissal means "stop proposing this
// process", so unlike identities/approvals the card disappears entirely). Highest coverage first,
// larger groups breaking ties — the strongest regularity is the one worth reviewing first.
patternsRouter.get("/api/patterns/candidates", async (_req, res) => {
  try {
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const dismissed = new Set(loadConfig().dismissedPatterns ?? []);
    const candidates = (await findPatternCandidates(db)).filter((c) => !dismissed.has(c.patternId));
    candidates.sort((x, y) => y.support / y.total - x.support / x.total || y.total - x.total);
    res.json({ candidates });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/patterns/resolve → { patternId, verdict: promote|risk|dismiss }. Promote/risk re-derive
// the candidate from a fresh scan (the scan IS the source of truth — no derived counts are ever
// persisted between requests) and ingest its record through sink + late-arrival repair; a stale
// patternId that no longer mines is a 404, not a silent write. Dismiss records the id so the
// pattern stops being proposed (no graph write).
patternsRouter.post("/api/patterns/resolve", async (req, res) => {
  try {
    const patternId = req.body?.patternId as string | undefined;
    const verdict = req.body?.verdict as string | undefined;
    if (typeof patternId !== "string" || !patternId || !["promote", "risk", "dismiss"].includes(verdict ?? "")) {
      return res.status(400).json({ error: 'expected { patternId: string, verdict: "promote" | "risk" | "dismiss" }' });
    }
    if (verdict === "dismiss") {
      saveConfig((cfg) => {
        const ids = cfg.dismissedPatterns ?? [];
        if (!ids.includes(patternId)) ids.push(patternId);
        cfg.dismissedPatterns = ids;
      });
      return res.json({ ok: true, patternId, verdict });
    }
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const candidate = (await findPatternCandidates(db)).find((c) => c.patternId === patternId);
    if (!candidate) return res.status(404).json({ error: `pattern ${patternId} no longer mines as a candidate — reload and re-review` });
    const { repairs } = await repairLateArrivals(guardDb, sink, verdictBatch(candidate, verdict as "promote" | "risk"), {
      pipelineId: PATTERN_REVIEW_ID,
    });
    logRepairs(PATTERN_REVIEW_ID, repairs);
    res.json({ ok: true, patternId, verdict });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
