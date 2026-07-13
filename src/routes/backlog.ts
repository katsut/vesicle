// Backlog routes: the OAuth connect flow, webhook install, and the poll lane, plus the public
// webhook receiver. Two routers because they sit on opposite sides of the session auth gate:
// backlogWebhookRouter is mounted BEFORE it (Backlog carries no session), backlogRouter after.

import express from "express";
import { randomBytes } from "node:crypto";
import { authorizeUrl, exchangeCode, refreshToken as refreshOAuthToken } from "../backlog-oauth.ts";
import { repairLateArrivals } from "../etl/guard.ts";
import { loadConfig, saveConfig } from "../etl/store.ts";
import { sink, guardDb, backlogSource, logRepairs } from "../runtime.ts";
import { POLL_MS, pipelineById, pollTimers, registerPollHandler, startPoller, stopPoller } from "../poller.ts";

export const backlogWebhookRouter = express.Router();
export const backlogRouter = express.Router();

// Streaming ingest from a Backlog webhook (public: Backlog carries no session). Backlog POSTs an
// activity the moment it happens; we map it to provenance-stamped typed facts and APPEND them to the
// live graph — no reset, this is a stream, not a load. Set BACKLOG_WEBHOOK_SECRET to require ?secret=…
// (recommended; Backlog itself sends no signature).
backlogWebhookRouter.post("/api/webhook/backlog", async (req, res) => {
  const secret = process.env.BACKLOG_WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ error: "bad webhook secret" });
  try {
    const event = backlogSource.webhookToEvents(req.body)?.[0];
    if (!event) return res.status(400).json({ error: "not a Backlog webhook activity" });
    // Best-effort lookups (status ids / user names in changes[]): a webhook can arrive before any
    // connection exists, and mapping degrades gracefully without them.
    const projectKey = (req.body as { project?: { projectKey?: string } })?.project?.projectKey;
    if (projectKey) {
      try {
        const conn = await freshBacklogConn();
        if (conn) await backlogSource.ensureLookups(conn, projectKey);
      } catch (e) {
        console.log(`  backlog lookups unavailable (${projectKey}): ${(e as Error).message}`);
      }
    }
    const batch = backlogSource.eventToBatch(event);
    if (!batch.items.length) return res.json({ ok: true, kind: batch.kind, facts: 0, note: batch.summary });
    if (!(await sink.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    // Webhook delivery can arrive out of order (redelivery/parallelism) — the guard repairs head.
    const { stats, repairs } = await repairLateArrivals(guardDb, sink, batch.items, { pipelineId: backlogSource.id });
    logRepairs(backlogSource.id, repairs);
    console.log(`  /api/webhook/backlog → ${batch.kind}: ${batch.summary}`);
    res.json({ ok: true, kind: batch.kind, summary: batch.summary, facts: batch.factCount, stats });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- Backlog OAuth connect flow: sign in, pick a project, install the webhook (OAuth only, no API
// keys). The connection is a single server-level record persisted in the config store
// (var/config.json), so it survives a restart and is not tied to who is signed in to Vesicle.
let backlogPending: { host: string; state: string } | null = null; // in-flight OAuth (one at a time)

export function publicUrl(): string {
  const u = process.env.PUBLIC_URL;
  if (!u) throw new Error("set PUBLIC_URL — this server's public https base (for the OAuth redirect + the webhook URL)");
  return u.replace(/\/$/, "");
}
function oauthApp(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.BACKLOG_CLIENT_ID;
  const clientSecret = process.env.BACKLOG_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("set BACKLOG_CLIENT_ID and BACKLOG_CLIENT_SECRET (from the Backlog OAuth app)");
  return { clientId, clientSecret, redirectUri: `${publicUrl()}/api/backlog/oauth/callback` };
}
// The Backlog connection with a fresh access token: refreshes (and persists the ROTATED token pair —
// Backlog invalidates the old refresh token) when the stored one is expired or about to be. `null`
// when not connected. A refresh the provider rejects (revoked grant) disconnects, so Sources shows
// the re-connect path; a transient failure (network) throws and the caller retries next cycle.
async function freshBacklogConn() {
  const c = loadConfig().sources.backlog;
  if (!c) return null;
  if (Date.now() < c.expiresAt - 60_000) return c;
  try {
    const oa = oauthApp();
    const tok = await refreshOAuthToken(c.host, { clientId: oa.clientId, clientSecret: oa.clientSecret, refreshToken: c.refreshToken });
    const next = saveConfig((cfg) => {
      if (cfg.sources.backlog) {
        cfg.sources.backlog.accessToken = tok.access_token;
        cfg.sources.backlog.refreshToken = tok.refresh_token;
        cfg.sources.backlog.expiresAt = Date.now() + tok.expires_in * 1000;
      }
    });
    console.log("  backlog OAuth token refreshed");
    return next.sources.backlog ?? null;
  } catch (e) {
    const msg = (e as Error).message;
    if (/failed \(4\d\d\)/.test(msg)) {
      saveConfig((cfg) => {
        delete cfg.sources.backlog;
      });
      console.log(`  backlog OAuth refresh rejected — disconnected: ${msg}`);
      return null;
    }
    throw e;
  }
}
async function backlogConn() {
  const c = await freshBacklogConn();
  if (!c) throw new Error("not connected to Backlog — sign in first");
  return c;
}

backlogRouter.get("/api/backlog/status", (_req, res) => {
  const c = loadConfig().sources.backlog;
  res.json({ connected: !!c, host: c?.host ?? null });
});

backlogRouter.get("/api/backlog/oauth/start", (req, res) => {
  try {
    const host = String(req.query.host ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]+\.(backlog\.(com|jp)|backlogtool\.com)$/.test(host)) {
      return res.status(400).json({ error: "host must be a Backlog space, e.g. example.backlog.com" });
    }
    const oa = oauthApp();
    const state = randomBytes(16).toString("hex");
    backlogPending = { host, state };
    res.redirect(authorizeUrl(host, oa.clientId, oa.redirectUri, state));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

backlogRouter.get("/api/backlog/oauth/callback", async (req, res) => {
  try {
    const pending = backlogPending;
    if (!pending) return res.status(400).type("html").send("<p>OAuth session expired — start again from <a href='/sources.html'>Sources</a>.</p>");
    if (String(req.query.state ?? "") !== pending.state) return res.status(400).send("state mismatch");
    const code = String(req.query.code ?? "");
    if (!code) return res.status(400).send("no authorization code");
    const oa = oauthApp();
    const tok = await exchangeCode(pending.host, { clientId: oa.clientId, clientSecret: oa.clientSecret, code, redirectUri: oa.redirectUri });
    saveConfig((c) => {
      c.sources.backlog = { host: pending.host, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    });
    backlogPending = null;
    res.redirect("/sources.html?connected=1"); // Sources shows the success banner; /connect stays reachable directly
  } catch (e) {
    res.status(500).type("html").send(`<p>OAuth failed: ${(e as Error).message}</p>`);
  }
});

backlogRouter.post("/api/backlog/disconnect", (_req, res) => {
  saveConfig((c) => {
    delete c.sources.backlog;
  });
  res.json({ ok: true });
});

backlogRouter.get("/api/backlog/projects", async (_req, res) => {
  try {
    const projects = await backlogSource.listProjects(await backlogConn());
    res.json({ projects: projects.map((p) => ({ id: p.id, projectKey: p.projectKey, name: p.name })) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

backlogRouter.post("/api/backlog/webhook", async (req, res) => {
  try {
    const conn = await backlogConn();
    const project = String(req.body?.project ?? "").trim();
    if (!project) return res.status(400).json({ error: "missing project" });
    const secret = process.env.BACKLOG_WEBHOOK_SECRET;
    const hookUrl = `${publicUrl()}/api/webhook/backlog${secret ? `?secret=${encodeURIComponent(secret)}` : ""}`;
    const hook = await backlogSource.installWebhook(conn, { project, hookUrl });
    saveConfig((c) => {
      if (c.sources.backlog) c.sources.backlog.projectKey = project;
    });
    res.json({ ok: true, id: hook.id, hookUrl: hook.hookUrl, activityTypeIds: hook.activityTypeIds });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Polling ingest (pull) — the tunnel-free path: the server periodically fetches recent Backlog
// activities over OAuth (outbound only) and streams them into StromaDB. No public URL needed, unlike
// the webhook (push). Same event→batch mapping consumes both shapes.
async function pollOnceBacklog(pipelineId: string): Promise<void> {
  const rt = pollTimers.get(pipelineId);
  const def = pipelineById(pipelineId);
  if (!rt || rt.busy || !def?.scope || !loadConfig().sources.backlog) return;
  rt.busy = true;
  try {
    const conn = await freshBacklogConn();
    if (!conn) return; // refresh rejected → disconnected; the lane idles until re-connect
    let cursor = def.cursor ?? 0;
    let facts = 0;
    const { events } = await backlogSource.poll(conn, def.scope, cursor);
    for (const e of events) {
      const batch = backlogSource.eventToBatch(e);
      if (batch.items.length) {
        // Poll delivery is ordered, so the guard is a no-op here in the common case — it protects
        // against upstream reordering and cursor rewinds.
        const { repairs } = await repairLateArrivals(guardDb, sink, batch.items, { pipelineId });
        logRepairs(pipelineId, repairs);
        facts += batch.factCount;
      }
      if (e.id > cursor) cursor = e.id;
    }
    // A live lane appends no run per cycle — it advances the durable counters on its def instead.
    const saved = saveConfig((cfg) => {
      const d = cfg.pipelines.find((p) => p.id === pipelineId);
      if (!d) return;
      d.cursor = cursor;
      d.ingested = (d.ingested ?? 0) + facts;
      if (events.length) d.lastEventAt = Date.now();
      d.lastError = null;
    });
    if (events.length) {
      const total = saved.pipelines.find((p) => p.id === pipelineId)?.ingested ?? facts;
      console.log(`  backlog poll (${def.scope}): ${events.length} new activities → cursor ${cursor}, ${total} facts total`);
    }
  } catch (e) {
    saveConfig((cfg) => {
      const d = cfg.pipelines.find((p) => p.id === pipelineId);
      if (d) d.lastError = (e as Error).message;
    });
    console.log(`  backlog poll error: ${(e as Error).message}`);
  } finally {
    rt.busy = false;
  }
}
registerPollHandler(backlogSource.id, pollOnceBacklog);

backlogRouter.post("/api/backlog/poll/start", (req, res) => {
  try {
    if (!loadConfig().sources.backlog) return res.status(400).json({ error: "not connected to Backlog" });
    const project = String(req.body?.project ?? "").trim();
    if (!project) return res.status(400).json({ error: "missing project" });
    // Upsert the lane. Same scope keeps the cursor (a restart resumes the stream); a new scope
    // rewinds to 0. The id "backlog" doubles as the provenance value the sink stamps on facts.
    saveConfig((cfg) => {
      const def = cfg.pipelines.find((p) => p.id === backlogSource.id);
      if (def) {
        if (def.scope !== project) {
          def.scope = project;
          def.cursor = 0;
          def.ingested = 0;
        }
        def.name = `${backlogSource.label} · ${project}`;
        def.state = "running";
        def.lastError = null;
      } else {
        cfg.pipelines.push({
          id: backlogSource.id,
          name: `${backlogSource.label} · ${project}`,
          source: backlogSource.id,
          mode: "poll",
          scope: project,
          state: "running",
          cursor: 0,
          ingested: 0,
          lastError: null,
        });
      }
      if (cfg.sources.backlog) cfg.sources.backlog.projectKey = project;
    });
    startPoller(backlogSource.id);
    res.json({ ok: true, project, intervalMs: POLL_MS });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

backlogRouter.post("/api/backlog/poll/stop", (_req, res) => {
  stopPoller(backlogSource.id);
  saveConfig((cfg) => {
    const def = cfg.pipelines.find((p) => p.id === backlogSource.id);
    if (def) def.state = "paused"; // keep the cursor — a later start on the same scope resumes
  });
  res.json({ ok: true });
});

backlogRouter.get("/api/backlog/poll/status", (_req, res) => {
  const def = pipelineById(backlogSource.id);
  const running = def?.state === "running" && pollTimers.has(backlogSource.id);
  res.json({ running, project: def?.scope ?? null, ingested: def?.ingested ?? 0, lastId: def?.cursor ?? 0, error: def?.lastError ?? null });
});
