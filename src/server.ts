// Vesicle authoring server: serves the confirm wizard and runs the real pipeline behind it.
//   GET  /               → the confirm wizard (public/wizard.html)
//   GET  /api/sources    → registered sources (built-in + sources/*.json plugins) for the picker
//   GET  /api/source     → one source's schema DDL + sample data (?id=<id>; defaults to built-in)
//   POST /api/propose    → { schema? } parse schema + LLM proposes ontology → { tables, mapping }
//   POST /api/apply      → { mapping, schema?, data? } transform → ingest → payoff on the live graph
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
import { authorizeUrl, exchangeCode } from "./backlog-oauth.ts";
import { StromaSink, type IngestStats } from "./etl/sink.ts";
import { BacklogSource } from "./etl/source.ts";
import { loadConfig, recordRun, saveConfig, type PipelineDef } from "./etl/store.ts";
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
const backlogSource = new BacklogSource();

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
    const batch = backlogSource.eventToBatch(event);
    if (!batch.items.length) return res.json({ ok: true, kind: batch.kind, facts: 0, note: batch.summary });
    if (!(await sink.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    const stats = await sink.ingest(batch.items, { pipelineId: backlogSource.id });
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
function backlogConn() {
  const c = loadConfig().sources.backlog;
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
    if (!pending) return res.status(400).type("html").send("<p>OAuth session expired — start again from <a href='/connect'>/connect</a>.</p>");
    if (String(req.query.state ?? "") !== pending.state) return res.status(400).send("state mismatch");
    const code = String(req.query.code ?? "");
    if (!code) return res.status(400).send("no authorization code");
    const oa = oauthApp();
    const tok = await exchangeCode(pending.host, { clientId: oa.clientId, clientSecret: oa.clientSecret, code, redirectUri: oa.redirectUri });
    saveConfig((c) => {
      c.sources.backlog = { host: pending.host, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000 };
    });
    backlogPending = null;
    res.redirect("/connect?connected=1");
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
    const projects = await backlogSource.listProjects(backlogConn());
    res.json({ projects: projects.map((p) => ({ id: p.id, projectKey: p.projectKey, name: p.name })) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/backlog/webhook", async (req, res) => {
  try {
    const conn = backlogConn();
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
  const rt = pollTimers.get(pipelineId);
  const def = pipelineById(pipelineId);
  const conn = loadConfig().sources.backlog; // the only poll-capable source today
  if (!rt || rt.busy || !def?.scope || !conn) return;
  rt.busy = true;
  try {
    let cursor = def.cursor ?? 0;
    let facts = 0;
    const { events } = await backlogSource.poll(conn, def.scope, cursor);
    for (const e of events) {
      const batch = backlogSource.eventToBatch(e);
      if (batch.items.length) {
        await sink.ingest(batch.items, { pipelineId });
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
  if (def.source === "backlog" && !loadConfig().sources.backlog) {
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

// Cache proposals by schema text: an LLM call is one-time per source (not per page-load / re-open /
// language switch). "Re-propose" (fresh=true) forces a new call. Keeps token spend minimal.
const proposeCache = new Map<string, { tables: unknown; mapping: unknown }>();

app.post("/api/propose", async (req, res) => {
  try {
    const schemaText = (req.body?.schema as string | undefined) ?? defaultSource().schema;
    const fresh = req.body?.fresh === true;
    if (!fresh) {
      const hit = proposeCache.get(schemaText);
      if (hit) {
        console.log("  /api/propose → cache hit (no LLM call)");
        return res.json(hit);
      }
    }
    const schema = parseSchema(schemaText);
    if (!schema.tables.length) return res.status(400).json({ error: "no tables found in the schema DDL" });
    console.log(`  /api/propose → LLM call${fresh ? " (forced re-propose)" : ""}`);
    const mapping = await proposeMapping(schema);
    const result = {
      tables: schema.tables.map((t) => ({ name: t.name, isJoin: t.isJoin, joins: t.joins })),
      mapping,
    };
    proposeCache.set(schemaText, result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/apply", async (req, res) => {
  try {
    const mapping = req.body?.mapping as Mapping | undefined;
    if (!mapping) return res.status(400).json({ error: "missing mapping" });
    const schema = parseSchema((req.body?.schema as string | undefined) ?? defaultSource().schema);
    let data: Rows;
    try {
      data = JSON.parse((req.body?.data as string | undefined) ?? defaultSource().data) as Rows;
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
