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
import type { DerivedRelation, Mapping } from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, "../public");
const SOURCES_DIR = resolve(HERE, "../sources");
const PORT = Number(process.env.PORT ?? 5178);
const DEFAULT_ID = "hr-sample"; // the source shown first / used when a request omits schema/data

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
  const s = new Stroma();
  if (!(await s.health())) return res.json({ reachable: false });
  try {
    const st = await s.stats();
    res.json({ reachable: true, stats: st });
  } catch (e) {
    res.json({ reachable: false, error: (e as Error).message });
  }
});

app.use(express.static(PUB));
app.get("/", (_req, res) => res.sendFile(resolve(PUB, "wizard.html")));

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

    const db = new Stroma();
    if (!(await db.health())) {
      return res.status(503).json({ error: `stroma-serve not reachable at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}` });
    }
    await db.ensureAuthed(); // API token if STROMA_API_TOKEN is set, else session login
    await db.reset(); // each apply loads into a clean graph (opt-in; no-op if reset is disabled)
    const stats = await db.ingest(tr.ndjson);

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
