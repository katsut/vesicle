// Identity resolution routes: cross-source Person duplicates surfaced as reviewable candidates, and
// the human verdict on each pair. Confirm writes graph facts (the same-as edge + review facts);
// dismiss only persists the pair in the config store — a non-identity is not a fact we can assert.
// Evidence classes whose evidence is mechanical (exact normalized email) also take ONE policy
// verdict (/policy) that keeps auto-confirming future candidates of the class.
// Mounted behind the session auth gate (server.ts).

import express from "express";
import { Stroma } from "../stroma.ts";
import { confirmIdentity, findCandidates, selectEmailExact, selectPolicyTargets, type Candidate } from "../identities.ts";
import { loadConfig, saveConfig } from "../etl/store.ts";

export const identitiesRouter = express.Router();

/** Dismissals are stored with the pair ordered low-high — one canonical key per pair. */
const pairKey = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

/** The review note stamped on policy-driven confirms, so each pair's facts carry a reference to
 *  the policy that licensed them. */
const EMAIL_POLICY_NOTE = "email-exact policy";

// GET /api/identities/candidates → deterministic cross-band candidate pairs with their review
// state. Already-confirmed and dismissed pairs are marked, not hidden; unresolved pairs sort first,
// email evidence (strong) before name evidence, dismissed pairs last. With the email-exact policy
// active, open email candidates are auto-confirmed during the scan (lazy — no background poller;
// each gets the exact per-pair ingest an individual confirm does) and returned as confirmed. The
// response carries the policy state so the UI can render the policy card.
identitiesRouter.get("/api/identities/candidates", async (_req, res) => {
  try {
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const cfg = loadConfig();
    const dismissedPairs = cfg.dismissedIdentityPairs ?? [];
    const isDismissed = (a: number, b: number): boolean => {
      const [lo, hi] = pairKey(a, b);
      return dismissedPairs.some(([x, y]) => x === lo && y === hi);
    };
    const policy = cfg.identityPolicies?.emailExact;
    const candidates = (await findCandidates(db)).map((c) => ({ ...c, dismissed: isDismissed(c.a.id, c.b.id) }));
    const targets = selectPolicyTargets(policy, candidates, dismissedPairs);
    for (const c of targets) {
      await confirmIdentity(db, { a: c.a.id, b: c.b.id, reviewer: policy?.reviewer ?? "policy", note: EMAIL_POLICY_NOTE });
      c.confirmed = true;
    }
    if (targets.length) console.log(`identities: email-exact policy auto-confirmed ${targets.length} pair(s)`);
    const rank = (c: Candidate & { dismissed: boolean }): number =>
      (!c.confirmed && !c.dismissed ? 0 : c.confirmed ? 2 : 4) + (c.evidence === "email" ? 0 : 1);
    candidates.sort((x, y) => rank(x) - rank(y));
    const openCount = candidates.filter((c) => c.evidence === "email" && !c.confirmed && !c.dismissed).length;
    res.json({ candidates, policy: { emailExact: { active: policy != null, openCount } } });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/identities/resolve → { a, b, decision: confirm|dismiss, reviewer?, note? }. Confirm
// ingests the same-as edge + review facts — every same-as edge requires this human POST, nothing is
// confirmed automatically. Dismiss records the pair so it stops being proposed (no graph write).
identitiesRouter.post("/api/identities/resolve", async (req, res) => {
  try {
    const a = Number(req.body?.a);
    const b = Number(req.body?.b);
    const decision = req.body?.decision as string | undefined;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || !["confirm", "dismiss"].includes(decision ?? "")) {
      return res.status(400).json({ error: "expected { a:int, b:int, decision: confirm|dismiss, reviewer?, note? }" });
    }
    if (decision === "dismiss") {
      const [lo, hi] = pairKey(a, b);
      saveConfig((cfg) => {
        const pairs = cfg.dismissedIdentityPairs ?? [];
        if (!pairs.some(([x, y]) => x === lo && y === hi)) pairs.push([lo, hi]);
        cfg.dismissedIdentityPairs = pairs;
      });
      return res.json({ ok: true, a, b, decision });
    }
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const note = req.body?.note as string | undefined;
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    await confirmIdentity(db, { a, b, reviewer, note });
    res.json({ ok: true, a, b, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/identities/policy → { evidenceClass: "email-exact", action: confirm|revoke, reviewer? }.
// The policy question asked once, instead of N identical pair verdicts: confirm stores the policy
// and applies the same per-pair ingest as an individual confirm (confirmIdentity) to every open
// email candidate now; from then on the candidates scan auto-confirms new ones. Revoke deletes the
// stored policy — auto-confirmation stops, facts already written stay.
// TODO: record the policy itself as graph data (v1 keeps it in the config store only).
identitiesRouter.post("/api/identities/policy", async (req, res) => {
  try {
    const evidenceClass = req.body?.evidenceClass as string | undefined;
    const action = req.body?.action as string | undefined;
    if (evidenceClass !== "email-exact" || !["confirm", "revoke"].includes(action ?? "")) {
      return res.status(400).json({ error: 'expected { evidenceClass: "email-exact", action: confirm|revoke, reviewer? }' });
    }
    if (action === "revoke") {
      saveConfig((cfg) => {
        delete cfg.identityPolicies?.emailExact;
      });
      return res.json({ ok: true, action });
    }
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    // The policy is saved before the sweep: if a per-pair ingest fails mid-loop, the next
    // candidates scan picks up the remainder.
    saveConfig((cfg) => {
      (cfg.identityPolicies ??= {}).emailExact = { decidedAt: Date.now(), reviewer };
    });
    const dismissed = loadConfig().dismissedIdentityPairs ?? [];
    const targets = selectEmailExact(await findCandidates(db), dismissed);
    for (const c of targets) {
      await confirmIdentity(db, { a: c.a.id, b: c.b.id, reviewer, note: EMAIL_POLICY_NOTE });
    }
    res.json({ ok: true, action, confirmed: targets.length, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/identities/confirm-all-email → { reviewer? }. One human verdict over one evidence
// class: every open exact-email candidate gets the exact per-pair ingest an individual confirm
// does (confirmIdentity: symmetric same-as + review facts, identity-review provenance). Dismissed
// and already-confirmed pairs are skipped; name-token candidates are untouched. A separate route
// rather than a /resolve extension: /resolve is shaped around one {a, b, decision} verdict, while
// this action takes no pair and answers with a count. Kept as the one-shot manual fallback to
// /policy — it confirms the current set without storing a policy.
identitiesRouter.post("/api/identities/confirm-all-email", async (req, res) => {
  try {
    const reviewer = (req.body?.reviewer as string | undefined) ?? "reviewer";
    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const dismissed = loadConfig().dismissedIdentityPairs ?? [];
    const targets = selectEmailExact(await findCandidates(db), dismissed);
    for (const c of targets) {
      await confirmIdentity(db, { a: c.a.id, b: c.b.id, reviewer });
    }
    res.json({ ok: true, confirmed: targets.length, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
