// Google Drive routes: OAuth connect, the structural poll lane, and the curated body lane
// (funnel → extract → access conformance). All routes sit behind the session auth gate.

import express from "express";
import { randomBytes } from "node:crypto";
import { authorizeUrl as gdriveAuthorizeUrl, exchangeCode as gdriveExchangeCode, refreshToken as refreshGoogleToken } from "../gdrive-oauth.ts";
import { DOC_MIME, PDF_MIME, downloadFile, exportDoc, getFile, getStartPageToken, hydrateFile, listChanges, listDrives, listFiles, parseFolderId, type DriveScope, type DriveFile, type GdriveApiConfig } from "../gdrive-api.ts";
import { driveFileToBatch, sensitivityLabel } from "../gdrive.ts";
import { DEFAULT_PATTERN, classifyFiles, claimsToBatch, extractClaims, type DocContent, type DocPattern } from "../gdrive-extract.ts";
import { evaluateSharing, recordSharingReview, type SharingDecision } from "../access-conformance.ts";
import { Stroma } from "../stroma.ts";
import { repairLateArrivals } from "../etl/guard.ts";
import { loadConfig, recordRun, saveConfig, type PipelineDef } from "../etl/store.ts";
import { sink, guardDb, logRepairs } from "../runtime.ts";
import { POLL_MS, pipelineById, pollTimers, registerPollHandler, startPoller, stopPoller } from "../poller.ts";
import { publicUrl } from "./backlog.ts";

export const gdriveRouter = express.Router();

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
registerPollHandler(GDRIVE_ID, pollOnceGdrive);

gdriveRouter.get("/api/gdrive/status", (_req, res) => {
  const c = loadConfig().sources.gdrive;
  res.json({ connected: !!c, scopeKind: c?.scopeKind ?? null, scopeId: c?.scopeId ?? null });
});

gdriveRouter.get("/api/gdrive/oauth/start", (_req, res) => {
  try {
    const oa = googleOauthApp();
    const state = randomBytes(16).toString("hex");
    gdrivePending = state;
    res.redirect(gdriveAuthorizeUrl(oa.clientId, oa.redirectUri, state));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

gdriveRouter.get("/api/gdrive/oauth/callback", async (req, res) => {
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

gdriveRouter.post("/api/gdrive/disconnect", (_req, res) => {
  saveConfig((c) => {
    delete c.sources.gdrive;
  });
  res.json({ ok: true });
});

// Scope picker: "My Drive" + the user's shared drives. A folder scope is entered by pasting a
// folder URL/id into the card (parsed server-side by poll/start).
gdriveRouter.get("/api/gdrive/scopes", async (_req, res) => {
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

gdriveRouter.post("/api/gdrive/poll/start", (req, res) => {
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

gdriveRouter.post("/api/gdrive/poll/stop", (_req, res) => {
  stopPoller(GDRIVE_ID);
  saveConfig((cfg) => {
    const def = cfg.pipelines.find((p) => p.id === GDRIVE_ID);
    if (def) def.state = "paused"; // keep the cursor token — a later start on the same scope resumes
  });
  res.json({ ok: true });
});

gdriveRouter.get("/api/gdrive/poll/status", (_req, res) => {
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
gdriveRouter.get("/api/gdrive/funnel", async (req, res) => {
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
gdriveRouter.post("/api/gdrive/extract", async (req, res) => {
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
gdriveRouter.get("/api/gdrive/access-conformance", async (req, res) => {
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
gdriveRouter.post("/api/gdrive/access-conformance/resolve", async (req, res) => {
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
