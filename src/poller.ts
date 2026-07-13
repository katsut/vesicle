// Shared poll-lane runtime: the interval timers keyed by pipeline id, the per-source poll handlers
// (registered by the route modules — the one indirection that keeps the poller ↔ route-module
// imports acyclic), and the boot restore that resumes lanes left running across a restart.

import { loadConfig, type PipelineDef } from "./etl/store.ts";

// The lane itself is a persisted PipelineDef in the config store: scope, cursor, counters, and
// lifecycle state survive a restart, and the cursor advances durably each cycle so a resumed lane
// picks up where it stopped. Runtime holds only what cannot be persisted — the interval timer and a
// busy flag — keyed by pipeline id, one poller per lane, not per session.
export const pollTimers = new Map<string, { timer: ReturnType<typeof setInterval>; busy: boolean }>();
export const POLL_MS = Number(process.env.BACKLOG_POLL_MS ?? 15000);

export const pipelineById = (id: string): PipelineDef | undefined => loadConfig().pipelines.find((p) => p.id === id);

const pollHandlers = new Map<string, (pipelineId: string) => Promise<void>>();

/** Register the poll cycle for one source (keyed by PipelineDef.source). */
export function registerPollHandler(source: string, fn: (pipelineId: string) => Promise<void>): void {
  pollHandlers.set(source, fn);
}

async function pollOnce(pipelineId: string): Promise<void> {
  // Dispatch by the lane's source — two poll-capable sources, no framework.
  const handler = pollHandlers.get(pipelineById(pipelineId)?.source ?? "");
  if (handler) return handler(pipelineId);
}

export function startPoller(pipelineId: string): void {
  stopPoller(pipelineId);
  pollTimers.set(pipelineId, { timer: setInterval(() => void pollOnce(pipelineId), POLL_MS), busy: false });
  void pollOnce(pipelineId); // kick off immediately
}

export function stopPoller(pipelineId: string): void {
  const rt = pollTimers.get(pipelineId);
  if (!rt) return;
  clearInterval(rt.timer);
  pollTimers.delete(pipelineId);
}

// Boot restore: resume every poll lane that was left running and still has its source connected — a
// server restart must not silently stop a stream (the persisted cursor picks up where it stopped).
export function restorePipelines(): void {
  for (const def of loadConfig().pipelines) {
    if (def.mode !== "poll" || def.state !== "running") continue;
    const connected = def.source === "gdrive" ? !!loadConfig().sources.gdrive : !!loadConfig().sources.backlog;
    if (!connected) {
      console.log(`  pipeline "${def.id}": left running but ${def.source} is not connected — not resumed`);
      continue;
    }
    startPoller(def.id);
    console.log(`  pipeline "${def.id}": resumed polling ${def.scope ?? "?"} every ${POLL_MS / 1000}s`);
  }
}
