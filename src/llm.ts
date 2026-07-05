// LLM backend for the mapping proposer. Pluggable on purpose:
//
//   PRODUCT PATH  — Vesicle's SERVER calls the Anthropic API with a key Vesicle holds (env
//                   ANTHROPIC_API_KEY / VESICLE_MODEL). The end user never needs any CLI or key.
//   DEV HARNESS   — if no API key is present, fall back to the local `claude` CLI. This is only for
//                   trying the proposer on a developer machine; it is NOT part of the shipped product.
//
// So the proposer ("can an LLM turn a schema into a good ontology?") works now via the CLI,
// while the real product path is a plain server-side API call.

import { spawn } from "node:child_process";

const MODEL = process.env.VESICLE_MODEL ?? "claude-opus-4-8";

export type Backend = "api" | "cli";

export function activeBackend(): Backend {
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

async function viaApi(prompt: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    const j = (await r.json()) as { content?: Array<{ text?: string }>; error?: { message?: string } };
    if (!r.ok) throw new Error(`anthropic api: ${j.error?.message ?? r.status}`);
    return (j.content ?? []).map((b) => b.text ?? "").join("").trim();
  } finally {
    clearTimeout(timer);
  }
}

function viaCli(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", MODEL], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.trim()}`));
      else resolve(out.trim());
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function callLLM(prompt: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return activeBackend() === "api" ? viaApi(prompt, timeoutMs) : viaCli(prompt, timeoutMs);
}

/** Extract the first JSON object from model text (fenced ```json block or a bare {...}). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in model output");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
