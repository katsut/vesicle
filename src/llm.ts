// LLM backend for the mapping proposer. Pluggable on purpose:
//
//   PRODUCT PATH  — Vesicle's SERVER calls the Anthropic API with a key Vesicle holds (env
//                   ANTHROPIC_API_KEY / VESICLE_MODEL). The end user never needs any CLI or key.
//   DEV HARNESS   — if no API key is present, fall back to the local `claude` CLI. This is only for
//                   trying the proposer on a developer machine; it is NOT part of the shipped product.
//
// So the proposer ("can an LLM turn a schema into a good ontology?") works now via the CLI,
// while the real product path is a plain server-side API call.
//
// PDF attachments (the Drive body lane reads PDFs natively — no parser dependency):
//   API — the request's content becomes blocks: a `document` block (base64, application/pdf)
//         followed by the text prompt.
//   CLI — the PDF is written to a temp dir under the OS tmpdir and the CLI is spawned with that
//         dir as cwd; the prompt opens with an @doc.pdf mention. Inside its own cwd the CLI's
//         read-only file access needs no permission grant, so `-p` mode can read the PDF either by
//         @-mention expansion or with its Read tool. The temp dir is removed afterwards.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.VESICLE_MODEL ?? "claude-opus-4-8";

export type Backend = "api" | "cli";

export function activeBackend(): Backend {
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

async function viaApi(prompt: string, timeoutMs: number, maxTokens: number, pdfBase64?: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const content = pdfBase64
    ? [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: prompt },
      ]
    : prompt;
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
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
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

function viaCli(prompt: string, timeoutMs: number, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", MODEL], { stdio: ["pipe", "pipe", "pipe"], cwd });
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

async function viaCliWithPdf(prompt: string, timeoutMs: number, pdfBase64: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-doc-"));
  try {
    await writeFile(join(dir, "doc.pdf"), Buffer.from(pdfBase64, "base64"));
    const full = `Read the PDF file @doc.pdf in your working directory — it is the attached DOCUMENT the instructions below refer to.\n\n${prompt}`;
    return await viaCli(full, timeoutMs, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function callLLM(
  prompt: string,
  opts: { timeoutMs?: number; maxTokens?: number; pdfBase64?: string } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxTokens = opts.maxTokens ?? 2048;
  if (activeBackend() === "api") return viaApi(prompt, timeoutMs, maxTokens, opts.pdfBase64);
  return opts.pdfBase64 ? viaCliWithPdf(prompt, timeoutMs, opts.pdfBase64) : viaCli(prompt, timeoutMs);
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
