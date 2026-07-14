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
//
// This file holds the express setup, session auth, and static pages; the API routes live in
// src/routes/* (mounted below, on either side of the auth gate), the poll-lane runtime in
// src/poller.ts, and the shared singletons in src/runtime.ts.

import "./env.ts"; // load ./.env before anything reads process.env
import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { restorePipelines } from "./poller.ts";
import { approvalsRouter } from "./routes/approvals.ts";
import { backlogRouter, backlogWebhookRouter } from "./routes/backlog.ts";
import { gdriveRouter } from "./routes/gdrive.ts";
import { identitiesRouter } from "./routes/identities.ts";
import { modelRouter } from "./routes/model.ts";
import { pipelinesRouter } from "./routes/pipelines.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 5178);

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
app.use(backlogWebhookRouter); // POST /api/webhook/backlog — public: Backlog carries no session

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

app.use(pipelinesRouter); // /api/status, /api/stroma-stats, /api/sink/reset, /api/pipelines, /api/conformance*
app.use(identitiesRouter); // /api/identities/*
app.use(approvalsRouter); // /api/approvals/*
app.use(backlogRouter); // /api/backlog/*
app.use(gdriveRouter); // /api/gdrive/*

app.use(express.static(PUB));
app.get("/", (_req, res) => res.sendFile(resolve(PUB, "wizard.html")));
app.get("/conformance", (_req, res) => res.sendFile(resolve(PUB, "conformance.html")));
app.get("/connect", (_req, res) => res.sendFile(resolve(PUB, "connect-backlog.html")));

app.use(modelRouter); // /api/sources, /api/source, /api/model*, /api/propose*, /api/apply, /api/evaluate

app.listen(PORT, () => {
  restorePipelines();
  console.log(`\n  Vesicle authoring  →  http://127.0.0.1:${PORT}/`);
  console.log(`  (stroma-serve expected at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"} for Apply)\n`);
});
