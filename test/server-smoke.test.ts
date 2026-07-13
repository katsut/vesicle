// Smoke test for the server: boots src/server.ts against an empty var dir (VESICLE_VAR_DIR) and
// asserts the read-only status endpoints answer with JSON. With no pipelines persisted, no pollers
// start and no external calls happen. Also asserts the session auth gate: /health and the Backlog
// webhook stay reachable without a session while /api/* behind the gate returns 401.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_TIMEOUT_MS = 15_000;

const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn the server on `port` with a fresh empty var dir; resolve once /health answers. */
async function startServer(port: number, extraEnv: Record<string, string>): Promise<string> {
  const varDir = mkdtempSync(join(tmpdir(), "vesicle-smoke-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: ROOT,
    // The server loads ./.env from cwd but never overrides variables that already exist, so pinning
    // BACKLOG_WEBHOOK_SECRET empty here keeps the webhook public even when a developer's .env sets it.
    env: { ...process.env, PORT: String(port), VESICLE_VAR_DIR: varDir, BACKLOG_WEBHOOK_SECRET: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (output += d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return base;
    } catch {
      // not listening yet — retry until the deadline
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`server on :${port} did not answer /health within ${BOOT_TIMEOUT_MS}ms\n${output}`);
}

test("status endpoints answer with JSON on an empty var dir (auth disabled)", async () => {
  const base = await startServer(5999, { VESICLE_NO_AUTH: "1" });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const backlog = await fetch(`${base}/api/backlog/status`);
  assert.equal(backlog.status, 200);
  assert.deepEqual(await backlog.json(), { connected: false, host: null });

  const gdrive = await fetch(`${base}/api/gdrive/status`);
  assert.equal(gdrive.status, 200);
  assert.deepEqual(await gdrive.json(), { connected: false, scopeKind: null, scopeId: null });

  const poll = await fetch(`${base}/api/backlog/poll/status`);
  assert.equal(poll.status, 200);
  assert.deepEqual(await poll.json(), { lanes: [] });

  const pipelines = await fetch(`${base}/api/pipelines`);
  assert.equal(pipelines.status, 200);
  assert.deepEqual(await pipelines.json(), { pipelines: [], runs: [] });
});

test("auth gate: /health and the webhook stay public, gated APIs return 401", async () => {
  const base = await startServer(5998, { VESICLE_NO_AUTH: "" });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);

  // gated: no session cookie → 401 (JSON for non-HTML clients; a browser GET gets the login page)
  const pipelines = await fetch(`${base}/api/pipelines`, { headers: { accept: "application/json" } });
  assert.equal(pipelines.status, 401);
  assert.deepEqual(await pipelines.json(), { error: "unauthorized" });

  // public webhook: reachable without a session (400 = rejected payload, not 401)
  const hook = await fetch(`${base}/api/webhook/backlog`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(hook.status, 400);
  assert.deepEqual(await hook.json(), { error: "not a Backlog webhook activity" });
});
