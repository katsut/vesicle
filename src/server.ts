// Vesicle authoring server: serves the confirm wizard and runs the real pipeline behind it.
//   GET  /               → the confirm wizard (public/wizard.html)
//   GET  /api/sources    → registered sources (built-in + sources/*.json plugins) for the picker
//   GET  /api/source     → one source's schema DDL + sample data (?id=<id>; defaults to built-in)
//   POST /api/propose    → { schema? } parse schema + LLM proposes a mapping against the shared type
//                          layer → { tables, mapping, model, additions }
//   GET  /api/model      → { model, mappings } — the shared type layer + every per-source mapping
//   POST /api/model/confirm → { sourceId, mapping, additions? } append new declarations to the shared
//                          layer (conflicting redefinitions rejected) + save the per-source mapping
//   POST /api/apply      → { mapping | sourceId, schema?, data? } transform → ingest → payoff on the
//                          live graph (sourceId applies the saved mapping composed with the layer)
//
// Sources are pluggable: drop a sources/<id>.json ({label,schema,data}) to register one, no code
// change. The source is also editable in the browser; if a request omits schema/data it falls back
// to the built-in sample. The LLM proposal is the core path; the browser just confirms it.
// Needs a stroma-serve reachable at STROMA_URL for /api/apply.

import "./env.ts"; // load ./.env before anything reads process.env
import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { parseSchema } from "./schema.ts";
import { proposeMapping } from "./propose.ts";
import { proposeDerived, composeDerived } from "./proposeDerived.ts";
import { transform } from "./transform.ts";
import type { TransformResult } from "./transform.ts";
import { Stroma } from "./stroma.ts";
import { planPayoff, runPayoff } from "./payoff.ts";
import { checkDerivedPath, evaluateDerived } from "./deriveEval.ts";
import { review, type Rule } from "./conformance.ts";
import { recordReview, type Decision } from "./review.ts";
import { authorizeUrl, exchangeCode, refreshToken as refreshOAuthToken } from "./backlog-oauth.ts";
import { authorizeUrl as gdriveAuthorizeUrl, exchangeCode as gdriveExchangeCode, refreshToken as refreshGoogleToken } from "./gdrive-oauth.ts";
import { DOC_MIME, PDF_MIME, downloadFile, exportDoc, getFile, getStartPageToken, hydrateFile, listChanges, listDrives, listFiles, parseFolderId, type DriveScope, type DriveFile, type GdriveApiConfig } from "./gdrive-api.ts";
import { driveFileToBatch, sensitivityLabel } from "./gdrive.ts";
import { DEFAULT_PATTERN, classifyFiles, claimsToBatch, extractClaims, type DocContent, type DocPattern } from "./gdrive-extract.ts";
import { evaluateSharing, recordSharingReview, type SharingDecision } from "./access-conformance.ts";
import { StromaSink, type IngestStats } from "./etl/sink.ts";
import { repairLateArrivals, type Repair } from "./etl/guard.ts";
import { BacklogSource } from "./etl/source.ts";
import { loadConfig, recordRun, saveConfig, type PipelineDef } from "./etl/store.ts";
import { additionsOf, appendToModel, bindingsOf, composeMapping, conflictsOf, type ModelAdditions } from "./model.ts";
import type { DerivedRelation, Mapping } from "./types.ts";

// Default decision-authority policy: a release must be approved by the manager of the assignee's
// department, as of the approval time. Authored here; the engine evaluates it deterministically.
const DEFAULT_CONFORMANCE_RULE: Rule = {
  subject_type: "Issue",
  scope: { predicate: "issue-type", equals: "release" },
  required: { hops: [{ predicate: "assigned-to" }, { predicate: "member-of" }, { predicate: "manager-of", as_of: "approved-at" }] },
  actual: "approved-by",
  absent_when: { predicate: "status", equals: "released" },
};

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, "../public");
const SOURCES_DIR = resolve(HERE, "../sources");
const PORT = Number(process.env.PORT ?? 5178);
const DEFAULT_ID = "hr-sample"; // the source shown first / used when a request omits schema/data

// ETL wiring: one shared sink for every engine write path (webhook ingest, poll ingest, apply); the
// Backlog source normalizes both transports (webhook push + poll pull) into the same batches.
// Read/query paths (payoff expand, conformance, evaluate) keep using the Stroma client directly.
const sink = new StromaSink(new Stroma(loadConfig().sink.url));
const guardDb = new Stroma(loadConfig().sink.url); // late-arrival guard reads — reads stay on the raw client
const backlogSource = new BacklogSource();

const logRepairs = (pipelineId: string, repairs: Repair[]): void => {
  for (const r of repairs) {
    console.log(`  late-arrival repair (${pipelineId}): re-asserted ${r.object ? "head" : "close"} of ${r.subject} "${r.predicate}" (current valid_from ${r.validFrom} > incoming ${r.incomingValidFrom})`);
  }
};

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

// --- auth: a session-cookie login (mirrors the Stroma console). Default admin/password, overridable
// via VESICLE_USER / VESICLE_PASSWORD; VESICLE_NO_AUTH=1 disables it (local dev — `pnpm serve:open`). ---
const USER = process.env.VESICLE_USER ?? "admin";
const PASS = process.env.VESICLE_PASSWORD ?? "password";
const NO_AUTH = process.env.VESICLE_NO_AUTH === "1";
const sessions = new Map<string, number>(); // token → unix-ms expiry
const SESSION_MS = 12 * 3600 * 1000;
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function cookieToken(req: express.Request): string | null {
  const m = /(?:^|;\s*)vesicle_session=([^;]+)/.exec(req.headers.cookie ?? "");
  return m ? m[1]! : null;
}
function authed(req: express.Request): boolean {
  if (NO_AUTH) return true;
  const t = cookieToken(req);
  if (!t) return false;
  const exp = sessions.get(t);
  if (exp && exp > Date.now()) return true;
  if (t) sessions.delete(t);
  return false;
}
function loginPage(msg = ""): string {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Vesicle — sign in</title><style>
:root{--accent:#2f9e73}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2efe6;
font-family:ui-sans-serif,system-ui,sans-serif;color:#211d15}form{background:#fffdf7;border:1px solid #e5dfd1;
border-radius:12px;box-shadow:0 14px 30px -16px rgba(60,50,30,.22);padding:26px 28px;width:300px}
h1{font-size:18px;margin:0 0 2px;display:flex;align-items:center;gap:9px}.dot{width:18px;height:18px;border-radius:50%;
background:radial-gradient(circle at 34% 32%,#3fbfa2,#2f9e73 60%,#237a58)}p{color:#8b8371;font-size:12.5px;margin:2px 0 18px}
input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid #d4ccba;border-radius:8px;margin-bottom:9px;background:#fff}
button{width:100%;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:none;border-radius:8px;padding:10px;cursor:pointer;margin-top:6px}
.err{color:#a23b3b;font-size:12.5px;min-height:16px}</style>
<form method=post action=/login><h1><span class=dot></span>Vesicle</h1><p>Sign in to continue.</p>
<div class=err>${msg}</div><input name=user placeholder="username" autofocus autocomplete=username>
<input name=password type=password placeholder="password" autocomplete=current-password>
<button type=submit>Sign in</button></form>`;
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false })); // login form POST

// public endpoints (no auth)
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/login", (_req, res) => res.type("html").send(loginPage()));
app.post("/login", (req, res) => {
  const ok = eq(String(req.body?.user ?? ""), USER) && eq(String(req.body?.password ?? ""), PASS);
  if (!ok) return res.status(401).type("html").send(loginPage("Wrong username or password."));
  const tok = randomBytes(24).toString("hex");
  sessions.set(tok, Date.now() + SESSION_MS);
  res.setHeader("Set-Cookie", `vesicle_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  res.redirect("/");
});

// Streaming ingest from a Backlog webhook (public: Backlog carries no session). Backlog POSTs an
// activity the moment it happens; we map it to provenance-stamped typed facts and APPEND them to the
// live graph — no reset, this is a stream, not a load. Set BACKLOG_WEBHOOK_SECRET to require ?secret=…
// (recommended; Backlog itself sends no signature).
app.post("/api/webhook/backlog", async (req, res) => {
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

// auth gate: everything below requires a session
app.use((req, res, next) => {
  if (authed(req)) return next();
  if (req.method === "GET" && req.accepts("html")) return res.status(401).type("html").send(loginPage());
  return res.status(401).json({ error: "unauthorized" });
});

app.post("/api/logout", (req, res) => {
  const t = cookieToken(req);
  if (t) sessions.delete(t);
  res.setHeader("Set-Cookie", "vesicle_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/status", async (_req, res) => {
  const url = process.env.STROMA_URL ?? "http://127.0.0.1:7687";
  const stroma = await new Stroma().health();
  res.json({ stroma, url, auth: !NO_AUTH, user: NO_AUTH ? null : USER });
});

// Live pipeline view polls this: engine reachability + write counters (a rising changelog head = facts streaming in).
app.get("/api/stroma-stats", async (_req, res) => {
  try {
    const st = await sink.stats();
    res.json(st ? { reachable: true, stats: st } : { reachable: false });
  } catch (e) {
    res.json({ reachable: false, error: (e as Error).message });
  }
});

// Admin: wipe the engine database. Deliberately NOT part of any ingest path — every pipeline loads
// incrementally; this is the one explicit destructive action (the sink settings surface calls it).
// Requires { confirm: true } so a stray call can't clear the graph. No-op if the engine runs without
// --allow-reset.
app.post("/api/sink/reset", async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ error: "pass { confirm: true } to reset the sink" });
  try {
    await sink.reset();
    console.log("  /api/sink/reset → engine database cleared");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- Backlog OAuth connect flow: sign in, pick a project, install the webhook (OAuth only, no API
// keys). The connection is a single server-level record persisted in the config store
// (var/config.json), so it survives a restart and is not tied to who is signed in to Vesicle.
let backlogPending: { host: string; state: string } | null = null; // in-flight OAuth (one at a time)

function publicUrl(): string {
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

app.get("/api/backlog/status", (_req, res) => {
  const c = loadConfig().sources.backlog;
  res.json({ connected: !!c, host: c?.host ?? null });
});

app.get("/api/backlog/oauth/start", (req, res) => {
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

app.get("/api/backlog/oauth/callback", async (req, res) => {
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

app.post("/api/backlog/disconnect", (_req, res) => {
  saveConfig((c) => {
    delete c.sources.backlog;
  });
  res.json({ ok: true });
});

app.get("/api/backlog/projects", async (_req, res) => {
  try {
    const projects = await backlogSource.listProjects(await backlogConn());
    res.json({ projects: projects.map((p) => ({ id: p.id, projectKey: p.projectKey, name: p.name })) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/backlog/webhook", async (req, res) => {
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
//
// The lane itself is a persisted PipelineDef in the config store: scope, cursor, counters, and
// lifecycle state survive a restart, and the cursor advances durably each cycle so a resumed lane
// picks up where it stopped. Runtime holds only what cannot be persisted — the interval timer and a
// busy flag — keyed by pipeline id, one poller per lane, not per session.
const pollTimers = new Map<string, { timer: ReturnType<typeof setInterval>; busy: boolean }>();
const POLL_MS = Number(process.env.BACKLOG_POLL_MS ?? 15000);

const pipelineById = (id: string): PipelineDef | undefined => loadConfig().pipelines.find((p) => p.id === id);

async function pollOnce(pipelineId: string): Promise<void> {
  // Dispatch by the lane's source — two poll-capable sources, no framework.
  if (pipelineById(pipelineId)?.source === GDRIVE_ID) return pollOnceGdrive(pipelineId);
  return pollOnceBacklog(pipelineId);
}

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

function startPoller(pipelineId: string): void {
  stopPoller(pipelineId);
  pollTimers.set(pipelineId, { timer: setInterval(() => void pollOnce(pipelineId), POLL_MS), busy: false });
  void pollOnce(pipelineId); // kick off immediately
}

function stopPoller(pipelineId: string): void {
  const rt = pollTimers.get(pipelineId);
  if (!rt) return;
  clearInterval(rt.timer);
  pollTimers.delete(pipelineId);
}

app.post("/api/backlog/poll/start", (req, res) => {
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

app.post("/api/backlog/poll/stop", (_req, res) => {
  stopPoller(backlogSource.id);
  saveConfig((cfg) => {
    const def = cfg.pipelines.find((p) => p.id === backlogSource.id);
    if (def) def.state = "paused"; // keep the cursor — a later start on the same scope resumes
  });
  res.json({ ok: true });
});

app.get("/api/backlog/poll/status", (_req, res) => {
  const def = pipelineById(backlogSource.id);
  const running = def?.state === "running" && pollTimers.has(backlogSource.id);
  res.json({ running, project: def?.scope ?? null, ingested: def?.ingested ?? 0, lastId: def?.cursor ?? 0, error: def?.lastError ?? null });
});

// --- Google Drive: OAuth connect + the structural lane (file/folder metadata, ownership, ACL —
// no document bodies). Mirrors the Backlog section: one server-level connection in the config
// store, one persisted poll lane whose id ("gdrive") doubles as the provenance value. Poll only —
// Drive push notifications need a public channel endpoint, out of scope for this lane.
//
// Cursor: the Drive Changes API page token (an opaque STRING → PipelineDef.cursorToken). The first
// cycle after start walks the full scope listing page by page, then adopts a changes token fetched
// BEFORE the walk, so changes made during the listing replay on the next cycle instead of being lost.

const GDRIVE_ID = "gdrive"; // lane id + provenance value
let gdrivePending: string | null = null; // in-flight OAuth state (one at a time)

function googleOauthApp(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (from the Google Cloud OAuth client)");
  return { clientId, clientSecret, redirectUri: `${publicUrl()}/api/gdrive/oauth/callback` };
}

// The Drive connection with a fresh access token. Same contract as freshBacklogConn, with Google's
// one difference: the refresh response usually OMITS refresh_token (Google does not rotate it), so
// the stored one is kept unless a new one arrives. A 4xx refresh (revoked grant) disconnects; a
// transient failure throws and the caller retries next cycle.
async function freshGdriveConn() {
  const c = loadConfig().sources.gdrive;
  if (!c) return null;
  if (Date.now() < c.expiresAt - 60_000) return c;
  try {
    const oa = googleOauthApp();
    const tok = await refreshGoogleToken({ clientId: oa.clientId, clientSecret: oa.clientSecret, refreshToken: c.refreshToken });
    const next = saveConfig((cfg) => {
      if (cfg.sources.gdrive) {
        cfg.sources.gdrive.accessToken = tok.access_token;
        if (tok.refresh_token) cfg.sources.gdrive.refreshToken = tok.refresh_token;
        cfg.sources.gdrive.expiresAt = Date.now() + tok.expires_in * 1000;
      }
    });
    console.log("  gdrive OAuth token refreshed");
    return next.sources.gdrive ?? null;
  } catch (e) {
    const msg = (e as Error).message;
    if (/failed \(4\d\d\)/.test(msg)) {
      saveConfig((cfg) => {
        delete cfg.sources.gdrive;
      });
      console.log(`  gdrive OAuth refresh rejected — disconnected: ${msg}`);
      return null;
    }
    throw e;
  }
}
async function gdriveConn() {
  const c = await freshGdriveConn();
  if (!c) throw new Error("not connected to Google Drive — sign in first");
  return c;
}

// PipelineDef.scope is a string — the Drive scope round-trips as "my-drive" | "folder:<id>" | "drive:<id>".
function parseDriveScope(scope: string | undefined): DriveScope | null {
  if (!scope) return null;
  if (scope === "my-drive") return { kind: "my-drive" };
  if (scope.startsWith("folder:")) return { kind: "folder", id: scope.slice("folder:".length) };
  if (scope.startsWith("drive:")) return { kind: "drive", id: scope.slice("drive:".length) };
  return null;
}
const driveScopeLabel = (s: DriveScope): string =>
  s.kind === "my-drive" ? "My Drive" : s.kind === "folder" ? `folder ${s.id}` : `drive ${s.id}`;

/** Hydrate (resolve shortcut, fetch missing ACL) → map → guarded ingest. Returns facts written. */
async function ingestDriveFile(cfg: GdriveApiConfig, file: DriveFile, pipelineId: string): Promise<number> {
  const batch = driveFileToBatch(await hydrateFile(cfg, file));
  if (!batch.items.length) return 0;
  const { repairs } = await repairLateArrivals(guardDb, sink, batch.items, { pipelineId });
  logRepairs(pipelineId, repairs);
  return batch.factCount;
}

async function pollOnceGdrive(pipelineId: string): Promise<void> {
  const rt = pollTimers.get(pipelineId);
  const def = pipelineById(pipelineId);
  const scope = parseDriveScope(def?.scope);
  if (!rt || rt.busy || !def || !scope || !loadConfig().sources.gdrive) return;
  rt.busy = true;
  try {
    const conn = await freshGdriveConn();
    if (!conn) return; // refresh rejected → disconnected; the lane idles until re-connect
    const cfg: GdriveApiConfig = { token: conn.accessToken };
    const driveId = scope.kind === "drive" ? scope.id : undefined;
    let files = 0;
    let facts = 0;
    const advance = (mutate: (d: PipelineDef) => void, pageFacts: number): void => {
      saveConfig((c) => {
        const d = c.pipelines.find((p) => p.id === pipelineId);
        if (!d) return;
        d.ingested = (d.ingested ?? 0) + pageFacts;
        if (pageFacts) d.lastEventAt = Date.now();
        d.lastError = null;
        mutate(d);
      });
    };

    if (!def.cursorToken) {
      // First cycle: fetch the changes cursor FIRST, then walk the full scope listing. Counters
      // persist per page; a crash mid-walk restarts the listing (idempotent — deterministic ids,
      // re-emitted facts supersede in place).
      const startToken = await getStartPageToken(cfg, driveId);
      let pageToken: string | undefined;
      do {
        const page = await listFiles(cfg, { scope, pageToken });
        let pageFacts = 0;
        for (const f of page.files) pageFacts += await ingestDriveFile(cfg, f, pipelineId);
        files += page.files.length;
        facts += pageFacts;
        pageToken = page.nextPageToken;
        advance(() => {}, pageFacts);
      } while (pageToken);
      advance((d) => {
        d.cursorToken = startToken;
      }, 0);
      console.log(`  gdrive initial listing (${driveScopeLabel(scope)}): ${files} files → ${facts} facts; cursor switched to changes token`);
      return;
    }

    // Steady state: drain the changes feed. nextPageToken = more pages now; newStartPageToken =
    // caught up until the next cycle. The token persists after every page.
    let token = def.cursorToken;
    let caughtUp = false;
    while (!caughtUp) {
      const r = await listChanges(cfg, token, driveId);
      let pageFacts = 0;
      for (const ch of r.changes) {
        if (ch.removed || !ch.file || ch.file.trashed) continue; // removals/trash: deferred (no node deletion v1)
        // The changes feed is corpus-wide for user scopes — keep a folder lane to its folder.
        if (scope.kind === "folder" && !(ch.file.parents ?? []).includes(scope.id)) continue;
        pageFacts += await ingestDriveFile(cfg, ch.file, pipelineId);
        files++;
      }
      facts += pageFacts;
      if (r.nextPageToken) token = r.nextPageToken;
      else {
        token = r.newStartPageToken ?? token;
        caughtUp = true;
      }
      advance((d) => {
        d.cursorToken = token;
      }, pageFacts);
    }
    if (files) console.log(`  gdrive poll (${driveScopeLabel(scope)}): ${files} changed files → ${facts} facts`);
  } catch (e) {
    saveConfig((c) => {
      const d = c.pipelines.find((p) => p.id === pipelineId);
      if (d) d.lastError = (e as Error).message;
    });
    console.log(`  gdrive poll error: ${(e as Error).message}`);
  } finally {
    rt.busy = false;
  }
}

app.get("/api/gdrive/status", (_req, res) => {
  const c = loadConfig().sources.gdrive;
  res.json({ connected: !!c, scopeKind: c?.scopeKind ?? null, scopeId: c?.scopeId ?? null });
});

app.get("/api/gdrive/oauth/start", (_req, res) => {
  try {
    const oa = googleOauthApp();
    const state = randomBytes(16).toString("hex");
    gdrivePending = state;
    res.redirect(gdriveAuthorizeUrl(oa.clientId, oa.redirectUri, state));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/gdrive/oauth/callback", async (req, res) => {
  try {
    if (!gdrivePending) return res.status(400).type("html").send("<p>OAuth session expired — start again from <a href='/sources.html'>Sources</a>.</p>");
    if (String(req.query.state ?? "") !== gdrivePending) return res.status(400).send("state mismatch");
    const code = String(req.query.code ?? "");
    if (!code) return res.status(400).send("no authorization code");
    const oa = googleOauthApp();
    const tok = await gdriveExchangeCode({ clientId: oa.clientId, clientSecret: oa.clientSecret, code, redirectUri: oa.redirectUri });
    // prompt=consent makes Google include refresh_token on the exchange; keep an already-stored one
    // as the fallback (re-connect without revocation can omit it in edge cases).
    const refresh = tok.refresh_token ?? loadConfig().sources.gdrive?.refreshToken;
    if (!refresh) {
      return res.status(500).type("html").send("<p>Google returned no refresh token — revoke the app's access at myaccount.google.com/permissions and connect again.</p>");
    }
    saveConfig((c) => {
      c.sources.gdrive = { accessToken: tok.access_token, refreshToken: refresh, expiresAt: Date.now() + tok.expires_in * 1000 };
    });
    gdrivePending = null;
    res.redirect("/sources.html?connected=gdrive");
  } catch (e) {
    res.status(500).type("html").send(`<p>OAuth failed: ${(e as Error).message}</p>`);
  }
});

app.post("/api/gdrive/disconnect", (_req, res) => {
  saveConfig((c) => {
    delete c.sources.gdrive;
  });
  res.json({ ok: true });
});

// Scope picker: "My Drive" + the user's shared drives. A folder scope is entered by pasting a
// folder URL/id into the card (parsed server-side by poll/start).
app.get("/api/gdrive/scopes", async (_req, res) => {
  try {
    const conn = await gdriveConn();
    const drives = await listDrives({ token: conn.accessToken });
    res.json({
      scopes: [
        { kind: "my-drive", id: null, name: "My Drive" },
        ...drives.map((d) => ({ kind: "drive", id: d.id, name: d.name })),
      ],
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/gdrive/poll/start", (req, res) => {
  try {
    if (!loadConfig().sources.gdrive) return res.status(400).json({ error: "not connected to Google Drive" });
    const kind = String(req.body?.scope?.kind ?? "").trim();
    const rawId = String(req.body?.scope?.id ?? "").trim();
    let scope: DriveScope;
    if (kind === "my-drive") scope = { kind: "my-drive" };
    else if (kind === "drive") {
      if (!rawId) return res.status(400).json({ error: "missing shared-drive id" });
      scope = { kind: "drive", id: rawId };
    } else if (kind === "folder") {
      const id = parseFolderId(rawId);
      if (!id) return res.status(400).json({ error: "not a Drive folder id or folder URL" });
      scope = { kind: "folder", id };
    } else {
      return res.status(400).json({ error: "scope.kind must be my-drive | drive | folder" });
    }
    const scopeStr = scope.kind === "my-drive" ? "my-drive" : `${scope.kind}:${scope.id}`;
    // Upsert the lane. Same scope keeps the cursor token (a restart resumes the changes stream);
    // a new scope re-runs the initial listing. The id "gdrive" doubles as the provenance value.
    saveConfig((cfg) => {
      const def = cfg.pipelines.find((p) => p.id === GDRIVE_ID);
      if (def) {
        if (def.scope !== scopeStr) {
          def.scope = scopeStr;
          delete def.cursorToken;
          def.ingested = 0;
        }
        def.name = `Google Drive · ${driveScopeLabel(scope)}`;
        def.state = "running";
        def.lastError = null;
      } else {
        cfg.pipelines.push({
          id: GDRIVE_ID,
          name: `Google Drive · ${driveScopeLabel(scope)}`,
          source: GDRIVE_ID,
          mode: "poll",
          scope: scopeStr,
          state: "running",
          ingested: 0,
          lastError: null,
        });
      }
      if (cfg.sources.gdrive) {
        cfg.sources.gdrive.scopeKind = scope.kind;
        cfg.sources.gdrive.scopeId = scope.kind === "my-drive" ? undefined : scope.id;
      }
    });
    startPoller(GDRIVE_ID);
    res.json({ ok: true, scope: scopeStr, intervalMs: POLL_MS });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/gdrive/poll/stop", (_req, res) => {
  stopPoller(GDRIVE_ID);
  saveConfig((cfg) => {
    const def = cfg.pipelines.find((p) => p.id === GDRIVE_ID);
    if (def) def.state = "paused"; // keep the cursor token — a later start on the same scope resumes
  });
  res.json({ ok: true });
});

app.get("/api/gdrive/poll/status", (_req, res) => {
  const def = pipelineById(GDRIVE_ID);
  const running = def?.state === "running" && pollTimers.has(GDRIVE_ID);
  res.json({
    running,
    scope: def?.scope ?? null,
    ingested: def?.ingested ?? 0,
    // listing = the initial full walk; changes = steady-state incremental cursor
    phase: def ? (def.cursorToken ? "changes" : "listing") : null,
    error: def?.lastError ?? null,
  });
});

// --- Drive body lane: curated one-shot extraction (issue-driven, never on the poll). The funnel
// lists and triages a scope BEFORE any LLM call; the extract endpoint reads only the files the
// human confirmed, one LLM call per document, sequentially (cost control). Runs record under the
// one-shot pipeline id "gdrive-extract"; facts carry per-document provenance drive:<fileId> set by
// the mapping itself (the sink's pipeline-id stamp only fills unset sources).

const GDRIVE_EXTRACT_ID = "gdrive-extract"; // one-shot run id in the pipeline history
const FUNNEL_CAP = 200; // no pagination UI — cap the funnel and flag truncation

// The funnel/extract scope arrives as the same round-trip string the poll lane uses
// ("my-drive" | "folder:<id-or-url>" | "drive:<id>"); folder ids accept pasted URLs.
function parseBodyScope(raw: unknown): DriveScope | null {
  const scope = parseDriveScope(typeof raw === "string" && raw ? raw : pipelineById(GDRIVE_ID)?.scope);
  if (scope?.kind === "folder") {
    const id = parseFolderId(scope.id);
    return id ? { kind: "folder", id } : null;
  }
  return scope;
}

// v1: the extraction pattern is request-scoped — sent in the body, defaulting to the regulation
// pattern. Validated structurally here so a malformed pattern fails the request, not the LLM call.
function parseDocPattern(raw: unknown): DocPattern | { error: string } {
  if (raw == null) return DEFAULT_PATTERN;
  const p = raw as Partial<DocPattern>;
  if (!Array.isArray(p.entity_types) || !p.entity_types.length || !p.entity_types.every((t) => typeof t === "string" && t)) {
    return { error: "pattern.entity_types must be a non-empty array of type names" };
  }
  if (!Array.isArray(p.predicates) || !p.predicates.length) {
    return { error: "pattern.predicates must be a non-empty array" };
  }
  for (const x of p.predicates) {
    if (
      typeof x?.name !== "string" || !x.name || typeof x.from !== "string" || typeof x.to !== "string" ||
      (x.kind !== "edge" && x.kind !== "value") || (x.card !== "one" && x.card !== "many")
    ) {
      return { error: `pattern predicate "${String(x?.name ?? "?")}" needs name/from/to, kind edge|value, card one|many` };
    }
  }
  const out: DocPattern = { entity_types: p.entity_types, predicates: p.predicates };
  if (typeof p.date_field === "string" && p.date_field) out.date_field = p.date_field;
  return out;
}

// Curation BEFORE any LLM call: list the scope (capped), hydrate (resolve shortcuts, fetch missing
// ACLs), and triage — readable PDFs/Docs with sensitivity tier + draft flag, everything else
// counted per mimeType.
app.get("/api/gdrive/funnel", async (req, res) => {
  try {
    const conn = await gdriveConn();
    const scope = parseBodyScope(req.query.scope);
    if (!scope) return res.status(400).json({ error: "missing or invalid scope (my-drive | folder:<id-or-url> | drive:<id>)" });
    const cfg: GdriveApiConfig = { token: conn.accessToken };
    const listed: DriveFile[] = [];
    let pageToken: string | undefined;
    let truncated = false;
    do {
      const page = await listFiles(cfg, { scope, pageToken });
      listed.push(...page.files);
      pageToken = page.nextPageToken;
      if (listed.length >= FUNNEL_CAP) {
        truncated = listed.length > FUNNEL_CAP || !!pageToken;
        listed.length = FUNNEL_CAP;
        break;
      }
    } while (pageToken);
    const hydrated: DriveFile[] = [];
    for (const f of listed) hydrated.push(await hydrateFile(cfg, f));
    const { files, skipped } = classifyFiles(hydrated);
    res.json({ files, skipped, total: listed.length, truncated });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// The one-shot body run over the confirmed selection. Files are processed SEQUENTIALLY (one LLM
// call per document); a per-file failure is reported, not fatal to the run. Records ONE run in the
// pipeline history per invocation.
app.post("/api/gdrive/extract", async (req, res) => {
  try {
    const conn = await gdriveConn();
    const fileIds = req.body?.fileIds as unknown;
    if (!Array.isArray(fileIds) || !fileIds.length || !fileIds.every((x): x is string => typeof x === "string" && !!x)) {
      return res.status(400).json({ error: "fileIds must be a non-empty array of Drive file ids" });
    }
    const pattern = parseDocPattern(req.body?.pattern);
    if ("error" in pattern) return res.status(400).json({ error: pattern.error });
    if (!(await sink.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const cfg: GdriveApiConfig = { token: conn.accessToken };
    const model = loadConfig().model;
    const startedAt = Date.now();
    const results: Array<{ fileId: string; name: string; ok: boolean; facts: number; error?: string }> = [];
    let totalFacts = 0;
    for (const fileId of fileIds) {
      let name = fileId;
      try {
        const file = await hydrateFile(cfg, await getFile(cfg, fileId));
        name = file.name ?? fileId;
        const mime = file.mimeType ?? "";
        let doc: DocContent;
        if (mime === DOC_MIME) doc = { kind: "text", text: await exportDoc(cfg, file.id) };
        else if (mime === PDF_MIME) doc = { kind: "pdf", base64: (await downloadFile(cfg, file.id)).base64 };
        else throw new Error(`unsupported mimeType ${mime || "(none)"} — only PDF and Google Docs are readable`);
        const claims = await extractClaims(pattern, doc);
        const batch = claimsToBatch({
          fileId: file.id,
          docLabel: sensitivityLabel(file.permissions),
          modifiedTime: file.modifiedTime,
          pattern,
          claims,
          model,
        });
        await sink.ingest(batch.items, { pipelineId: GDRIVE_EXTRACT_ID });
        totalFacts += batch.factCount;
        results.push({ fileId, name, ok: true, facts: batch.factCount });
        console.log(`  gdrive extract: "${name}" → ${batch.factCount} facts (${batch.entityCount} entities${batch.requiresFloor != null ? `, requires-floor ${batch.requiresFloor}` : ""})`);
      } catch (e) {
        results.push({ fileId, name, ok: false, facts: 0, error: (e as Error).message });
        console.log(`  gdrive extract: "${name}" failed: ${(e as Error).message}`);
      }
    }
    const failed = results.filter((r) => !r.ok);
    recordRun({
      pipelineId: GDRIVE_EXTRACT_ID,
      kind: "one-shot",
      startedAt,
      finishedAt: Date.now(),
      events: results.length,
      facts: totalFacts,
      error: failed.length ? `${failed.length}/${results.length} files failed: ${failed[0]!.error}` : null,
    });
    res.json({ ok: !failed.length, results, facts: totalFacts });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Access-policy conformance: the declared requirement (requires-floor, recorded at extraction) vs
// the OBSERVED sharing (fresh ACL-derived tier from the Drive API). Deterministic, token-zero; a
// document whose observed tier is looser than its required floor is over-shared.
app.get("/api/gdrive/access-conformance", async (req, res) => {
  try {
    const conn = await gdriveConn();
    const scope = parseBodyScope(req.query.scope);
    if (!scope) return res.status(400).json({ error: "missing or invalid scope (my-drive | folder:<id-or-url> | drive:<id>)" });
    const db = new Stroma(loadConfig().sink.url);
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const report = await evaluateSharing({ token: conn.accessToken }, scope, db);
    res.json(report);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// The human verdict on a document's sharing, written back as facts (the review flywheel, Document
// subjects). `confirmed` = the over-share is real and being fixed at the source; `waived` = the
// sharing is intentionally broad.
app.post("/api/gdrive/access-conformance/resolve", async (req, res) => {
  try {
    const node = Number(req.body?.node);
    const decision = req.body?.decision as SharingDecision | undefined;
    if (!Number.isInteger(node) || !["confirmed", "waived"].includes(decision ?? "")) {
      return res.status(400).json({ error: "expected { node:int, decision: confirmed|waived, reviewer?, note? }" });
    }
    const reviewer = (req.body?.reviewer as string | undefined) ?? process.env.VESICLE_REVIEWER ?? "reviewer";
    const note = req.body?.note as string | undefined;
    const db = new Stroma(loadConfig().sink.url);
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    await recordSharingReview(db, { node, decision: decision as SharingDecision, reviewer, note });
    res.json({ ok: true, node, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// All persisted lanes plus the capped run history — the read model for the pipelines UI. Additive:
// the per-source endpoints above keep serving the existing pages.
app.get("/api/pipelines", (_req, res) => {
  const cfg = loadConfig();
  res.json({ pipelines: cfg.pipelines, runs: cfg.runs });
});

// Boot restore: resume every poll lane that was left running and still has its source connected — a
// server restart must not silently stop a stream (the persisted cursor picks up where it stopped).
for (const def of loadConfig().pipelines) {
  if (def.mode !== "poll" || def.state !== "running") continue;
  const connected = def.source === GDRIVE_ID ? !!loadConfig().sources.gdrive : !!loadConfig().sources.backlog;
  if (!connected) {
    console.log(`  pipeline "${def.id}": left running but ${def.source} is not connected — not resumed`);
    continue;
  }
  startPoller(def.id);
  console.log(`  pipeline "${def.id}": resumed polling ${def.scope ?? "?"} every ${POLL_MS / 1000}s`);
}

// POST /api/conformance → { rule? } evaluate the declared decision-authority rule in the engine
// (deterministic, no LLM) and return a human-reviewable report of the gaps (ABSENT + MISMATCH).
app.post("/api/conformance", async (req, res) => {
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
// gap as human-asserted facts (the flywheel's first turn).
app.post("/api/conformance/resolve", async (req, res) => {
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
    res.json({ ok: true, issue, decision, reviewer });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.use(express.static(PUB));
app.get("/", (_req, res) => res.sendFile(resolve(PUB, "wizard.html")));
app.get("/conformance", (_req, res) => res.sendFile(resolve(PUB, "conformance.html")));
app.get("/connect", (_req, res) => res.sendFile(resolve(PUB, "connect-backlog.html")));

// list registered sources (built-in + plugins) for the picker
app.get("/api/sources", (_req, res) => {
  res.json({ sources: sources().map((s) => ({ id: s.id, label: s.label })) });
});

// one source's schema + data (defaults to the built-in when no/unknown id)
app.get("/api/source", (req, res) => {
  const s = sourceById(req.query.id as string | undefined);
  res.json({ id: s.id, label: s.label, schema: s.schema, data: s.data });
});

// The model split, read side: the shared type layer (ONE per deployment) + every per-source mapping.
app.get("/api/model", (_req, res) => {
  const cfg = loadConfig();
  res.json({ model: cfg.model, mappings: cfg.mappings });
});

// Set (or clear, with null) a predicate's sensitivity floor — the minimum access label facts/claims
// of that predicate get, whatever their source's own sharing state derived. Automatic assignment only
// ever RAISES a label above its source-derived tier; this endpoint is the one explicit human edit
// that can also lower or remove a floor.
app.post("/api/model/sensitivity", (req, res) => {
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
app.post("/api/model/confirm", (req, res) => {
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

app.post("/api/propose", async (req, res) => {
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

app.post("/api/apply", async (req, res) => {
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
    recordRun({ pipelineId: "apply", kind: "one-shot", startedAt, finishedAt: Date.now(), events, facts, error: null });

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

app.post("/api/propose-derived", async (req, res) => {
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
app.post("/api/evaluate", handleEvaluate);
app.get("/api/evaluate", handleEvaluate);

app.listen(PORT, () => {
  console.log(`\n  Vesicle authoring  →  http://127.0.0.1:${PORT}/`);
  console.log(`  (stroma-serve expected at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"} for Apply)\n`);
});
