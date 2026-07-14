// Approval routes: deterministic approval candidates from comment text, and the human verdict on
// each. Confirm writes graph facts (approved-by / approved-at + review facts); dismiss only
// persists the (comment, issue) pair in the config store — a non-approval is not a fact we can
// assert. Mounted behind the session auth gate (server.ts).

import express from "express";
import { Stroma } from "../stroma.ts";
import { confirmApproval, findApprovalCandidates, type Candidate } from "../approvals.ts";
import { loadConfig, saveConfig } from "../etl/store.ts";

export const approvalsRouter = express.Router();

// GET /api/approvals/candidates → deterministic comment-scan candidates with their review state.
// Already-confirmed and dismissed candidates are marked, not hidden; unresolved candidates sort
// first, formal evidence (strong) before euphemism, dismissed candidates last; newest comment first
// within each group.
approvalsRouter.get("/api/approvals/candidates", async (_req, res) => {
  try {
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const dismissed = loadConfig().dismissedApprovals ?? [];
    const isDismissed = (comment: number, issue: number): boolean => dismissed.some(([c, i]) => c === comment && i === issue);
    const candidates = (await findApprovalCandidates(db)).map((c) => ({ ...c, dismissed: isDismissed(c.comment, c.issue) }));
    const rank = (c: Candidate): number =>
      (!c.confirmed && !c.dismissed ? 0 : c.confirmed ? 2 : 4) + (c.tier === "formal" ? 0 : 1);
    candidates.sort((x, y) => rank(x) - rank(y) || y.at - x.at);
    res.json({ candidates });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/approvals/resolve → { comment, issue, approver, at, decision: confirm|dismiss,
// reviewer?, note? }. Confirm ingests the approved-by/approved-at facts + review facts — every
// approved-by fact requires this human POST, nothing is confirmed automatically. Dismiss records
// the (comment, issue) pair so it stops being proposed (no graph write).
approvalsRouter.post("/api/approvals/resolve", async (req, res) => {
  try {
    const comment = Number(req.body?.comment);
    const issue = Number(req.body?.issue);
    const approver = Number(req.body?.approver);
    const at = Number(req.body?.at);
    const decision = req.body?.decision as string | undefined;
    if (![comment, issue, approver, at].every(Number.isInteger) || !["confirm", "dismiss"].includes(decision ?? "")) {
      return res.status(400).json({ error: "expected { comment:int, issue:int, approver:int, at:int, decision: confirm|dismiss, reviewer?, note? }" });
    }
    if (decision === "dismiss") {
      saveConfig((cfg) => {
        const pairs = cfg.dismissedApprovals ?? [];
        if (!pairs.some(([c, i]) => c === comment && i === issue)) pairs.push([comment, issue]);
        cfg.dismissedApprovals = pairs;
      });
      return res.json({ ok: true, comment, issue, decision });
    }
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const note = req.body?.note as string | undefined;
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    await confirmApproval(db, { comment, issue, approver, at, reviewer, note });
    res.json({ ok: true, comment, issue, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
