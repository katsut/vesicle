// Cross-source read-model and admin routes: server status, engine stats, the explicit sink reset,
// the pipelines view, and decision-authority conformance. All behind the session auth gate.

import express from "express";
import { Stroma } from "../stroma.ts";
import { review, type Rule } from "../conformance.ts";
import { recordReview, type Decision } from "../review.ts";
import { laneMetrics, loadConfig } from "../etl/store.ts";
import { recordDecision } from "../review-records.ts";
import { sink } from "../runtime.ts";

// Default decision-authority policy: a release must be approved by the manager of the assignee's
// department, as of the approval time. Authored here; the engine evaluates it deterministically.
const DEFAULT_CONFORMANCE_RULE: Rule = {
  subject_type: "Issue",
  scope: { predicate: "issue-type", equals: "release" },
  required: { hops: [{ predicate: "assigned-to" }, { predicate: "member-of" }, { predicate: "manager-of", as_of: "approved-at" }] },
  actual: "approved-by",
  absent_when: { predicate: "status", equals: "released" },
};

// /api/status reports the auth mode — these mirror the env reads behind the gate in server.ts.
const USER = process.env.VESICLE_USER ?? "admin";
const NO_AUTH = process.env.VESICLE_NO_AUTH === "1";

export const pipelinesRouter = express.Router();

pipelinesRouter.get("/api/status", async (_req, res) => {
  const url = process.env.STROMA_URL ?? "http://127.0.0.1:7687";
  const stroma = await new Stroma().health();
  res.json({ stroma, url, auth: !NO_AUTH, user: NO_AUTH ? null : USER });
});

// Live pipeline view polls this: engine reachability + write counters (a rising changelog head = facts streaming in).
pipelinesRouter.get("/api/stroma-stats", async (_req, res) => {
  try {
    const st = await sink.stats();
    res.json(st ? { reachable: true, stats: st } : { reachable: false });
  } catch (e) {
    res.json({ reachable: false, error: (e as Error).message });
  }
});

// The Sink page's system panel: /stats verbatim (server identity, catalog, label tiers, provenance
// sources) plus the overview op's type×count composition — one composed payload, engine-derived —
// plus per-lane compression totals (source units observed vs facts produced) from the config store.
pipelinesRouter.get("/api/sink/info", async (_req, res) => {
  try {
    const url = process.env.STROMA_URL ?? "http://127.0.0.1:7687";
    const stats = await sink.stats();
    if (!stats) return res.json({ reachable: false, url });
    let composition: Array<{ type: string; count: number }> = [];
    try {
      const db = new Stroma();
      await db.ensureAuthed();
      const ov = (await db.query({ op: "overview" })) as { nodes?: Array<{ name?: string; count?: number }> };
      composition = (ov.nodes ?? [])
        .map((n) => ({ type: n.name ?? "?", count: n.count ?? 0 }))
        .sort((a, b) => b.count - a.count);
    } catch (e) {
      console.log(`  /api/sink/info: overview unavailable: ${(e as Error).message}`);
    }
    const cfg = loadConfig();
    res.json({ reachable: true, url, stats, composition, lanes: laneMetrics(cfg.pipelines, cfg.runs) });
  } catch (e) {
    res.json({ reachable: false, error: (e as Error).message });
  }
});

// Admin: wipe the engine database. Deliberately NOT part of any ingest path — every pipeline loads
// incrementally; this is the one explicit destructive action (the sink settings surface calls it).
// Requires { confirm: true } so a stray call can't clear the graph. No-op if the engine runs without
// --allow-reset.
pipelinesRouter.post("/api/sink/reset", async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: "pass { confirm: true } to reset the sink" });
  try {
    await sink.reset();
    console.log("  /api/sink/reset → engine database cleared");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// All persisted lanes plus the capped run history — the read model for the pipelines UI. Additive:
// the per-source endpoints keep serving the existing pages.
pipelinesRouter.get("/api/pipelines", (_req, res) => {
  const cfg = loadConfig();
  res.json({ pipelines: cfg.pipelines, runs: cfg.runs });
});

// POST /api/conformance → { rule? } evaluate the declared decision-authority rule in the engine
// (deterministic, no LLM) and return a human-reviewable report of the gaps (ABSENT + MISMATCH).
pipelinesRouter.post("/api/conformance", async (req, res) => {
  try {
    const rule = (req.body?.rule as Rule | undefined) ?? DEFAULT_CONFORMANCE_RULE;
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    await db.ensureAuthed();
    const report = await review(db, rule);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/conformance/resolve → { issue, decision, reviewer?, note? } record a human decision on a
// gap as human-asserted facts (the flywheel's first turn). The verdict also lands a ReviewRecord:
// the gap is re-derived from a fresh engine evaluation of the default rule so the record restates
// what the reviewer ruled on (verdict kind, required vs actual) server-side; a subject that no
// longer evaluates as a gap (or one reviewed under a custom rule) records the id only.
pipelinesRouter.post("/api/conformance/resolve", async (req, res) => {
  try {
    const issue = Number(req.body?.issue);
    const decision = req.body?.decision as Decision | undefined;
    if (!Number.isInteger(issue) || !["confirmed", "waived", "data-gap"].includes(decision ?? "")) {
      return res.status(400).json({ error: "expected { issue:int, decision: confirmed|waived|data-gap, reviewer?, note? }" });
    }
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const note = req.body?.note as string | undefined;
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    await db.ensureAuthed();
    await recordReview(db, { issue, decision: decision as Decision, reviewer, note });
    const gap = (await review(db, DEFAULT_CONFORMANCE_RULE)).gaps.find((g) => g.subject === issue);
    await recordDecision(sink, {
      surface: "decision-conformance",
      key: String(issue),
      decision: decision as string,
      proposal: gap ? `authority gap on ${gap.name}: ${gap.why}` : `authority gap on issue ${issue}`,
      evidence: gap ? `${gap.verdict}${gap.kind ? `/${gap.kind}` : ""} — required ${gap.requiredName ?? "?"}, actual ${gap.actualName ?? "none"}` : undefined,
      reviewer,
      note,
      at: Math.floor(Date.now() / 1000),
      issues: [issue],
    });
    res.json({ ok: true, issue, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
