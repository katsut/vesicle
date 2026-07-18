// Approval routes: deterministic approval candidates from comment text, and the human verdict on
// each. Confirm writes graph facts (approved-by / approved-at + review facts); dismiss persists
// the (comment, issue) pair in the config store — a non-approval is not a fact we can assert.
// Every verdict additionally lands a ReviewRecord (proposal + phrase evidence + decision,
// provenance human-review), so rejections survive as labelled negatives too.
// Mounted behind the session auth gate (server.ts).

import express from "express";
import { Stroma } from "../stroma.ts";
import { approverContexts, confirmApproval, findApprovalCandidates, type Candidate } from "../approvals.ts";
import { loadConfig, saveConfig } from "../etl/store.ts";
import { recordDecision } from "../review-records.ts";
import { sink } from "../runtime.ts";

export const approvalsRouter = express.Router();

const now = (): number => Math.floor(Date.now() / 1000);

/** One candidate verdict → one ReviewRecord. The candidate (when the comment still mines) restates
 *  the matched phrase and its snippet server-side; a verdict on one that no longer mines records
 *  the ids only. */
async function recordApprovalDecision(input: {
  comment: number;
  issue: number;
  approver: number;
  cand: Candidate | undefined;
  decision: "confirmed" | "dismissed";
  reviewer: string;
  note?: string;
}): Promise<void> {
  const { cand } = input;
  await recordDecision(sink, {
    surface: "approvals",
    key: `${input.comment}|${input.issue}`,
    decision: input.decision,
    proposal: cand
      ? `approved-by: ${cand.approverName ?? cand.approver} on ${cand.issueKey ?? cand.issue}${cand.summary ? ` — ${cand.summary}` : ""}`
      : `approved-by: ${input.approver} on ${input.issue}`,
    evidence: cand ? `${cand.tier} phrase "${cand.pattern}": …${cand.snippet}…` : undefined,
    reviewer: input.reviewer,
    note: input.note,
    at: now(),
    persons: [input.approver],
    issues: [input.issue],
  });
}

// GET /api/approvals/candidates → deterministic comment-scan candidates with their review state.
// Already-confirmed and dismissed candidates are marked, not hidden; unresolved candidates sort
// first, formal evidence (strong) before euphemism, dismissed candidates last; newest comment first
// within each group. Each candidate carries approverContext — what the graph already knows about
// the approver (activity counts, confirmed linked accounts) — gathered once for all approvers;
// absent when the graph knows nothing.
approvalsRouter.get("/api/approvals/candidates", async (_req, res) => {
  try {
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const dismissed = loadConfig().dismissedApprovals ?? [];
    const isDismissed = (comment: number, issue: number): boolean => dismissed.some(([c, i]) => c === comment && i === issue);
    const scanned = await findApprovalCandidates(db);
    const contexts = await approverContexts(db, new Set(scanned.map((c) => c.approver)));
    const candidates = scanned.map((c) => ({ ...c, dismissed: isDismissed(c.comment, c.issue), approverContext: contexts.get(c.approver) }));
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
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const note = req.body?.note as string | undefined;
    if (decision === "dismiss") {
      saveConfig((cfg) => {
        const pairs = cfg.dismissedApprovals ?? [];
        if (!pairs.some(([c, i]) => c === comment && i === issue)) pairs.push([comment, issue]);
        cfg.dismissedApprovals = pairs;
      });
      // The config suppression must survive an offline engine; the labelled-negative record needs
      // the engine, so it lands when reachable and is logged as skipped otherwise.
      const db = new Stroma();
      if (await db.health()) {
        const cand = (await findApprovalCandidates(db)).find((c) => c.comment === comment && c.issue === issue);
        await recordApprovalDecision({ comment, issue, approver, cand, decision: "dismissed", reviewer, note });
      } else {
        console.log(`approvals: engine offline — dismissal of ${comment}/${issue} suppressed in config only, no ReviewRecord`);
      }
      return res.json({ ok: true, comment, issue, decision });
    }
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const cand = (await findApprovalCandidates(db)).find((c) => c.comment === comment && c.issue === issue);
    await confirmApproval(db, { comment, issue, approver, at, reviewer, note });
    await recordApprovalDecision({ comment, issue, approver, cand, decision: "confirmed", reviewer, note });
    res.json({ ok: true, comment, issue, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
