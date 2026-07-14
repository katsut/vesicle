// Persisted connector config — var/config.json. Runtime state, not code: the sink URL, one connection
// per source (OAuth tokens live here, so var/ is git-ignored), the model split (ONE shared type layer
// + one mapping per source), pipeline definitions, and their run history. Loaded once into an
// in-memory cache; every save writes a tmp file and renames it into place, so a crash never leaves a
// torn file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { seedModel, type SharedModel, type SourceMapping } from "../model.ts";

/** The saved Backlog connection: the OAuth grant for the space (projects live on the poll lanes). */
export interface BacklogConnection {
  /** the space host, e.g. example.backlog.com */
  host: string;
  accessToken: string;
  refreshToken: string;
  /** unix-ms expiry of the access token */
  expiresAt: number;
}

/** The saved Google Drive connection: the OAuth grant plus the last scope picked for streaming.
 *  Google's endpoints are central (no per-tenant host), and the refresh token is NOT rotated on
 *  refresh — the refresh flow keeps the stored one when the response omits it. */
export interface GdriveConnection {
  accessToken: string;
  refreshToken: string;
  /** unix-ms expiry of the access token */
  expiresAt: number;
  scopeKind?: "my-drive" | "folder" | "drive";
  scopeId?: string;
}

/** One persisted ingestion lane: a single source wired into the sink, with lifecycle and counters.
 *  The pipeline id doubles as the provenance value the sink stamps on facts (see StromaSink.ingest).
 *  Backlog poll lanes use id "backlog:<PROJECTKEY>", one per project; the lane that predates that
 *  scheme keeps its legacy id "backlog" — the wire value the graph already contains. */
export interface PipelineDef {
  id: string;
  name: string;
  /** source id, e.g. "backlog" */
  source: string;
  mode: "poll" | "webhook" | "one-shot";
  /** what the lane reads from its source, e.g. a Backlog project id/key */
  scope?: string;
  /** lifecycle: a running poll lane is resumed on boot; a paused one is not */
  state: "running" | "paused";
  /** last seen upstream event id (poll mode, numeric cursors — Backlog) */
  cursor?: number;
  /** opaque string cursor (poll mode, token cursors — the Drive Changes page token); absent until the
   *  lane's initial full listing completes, reset when the scope changes */
  cursorToken?: string;
  /** facts ingested since the cursor was last reset */
  ingested?: number;
  /** unix-ms of the last poll cycle that saw events */
  lastEventAt?: number;
  lastError?: string | null;
}

/** One recorded execution. Live poll lanes do NOT append a run per cycle (they update counters on
 *  their PipelineDef); one-shot applies append one run each. "backfill" is reserved — nothing
 *  produces it yet. */
export interface PipelineRun {
  pipelineId: string;
  kind: "live" | "one-shot" | "backfill";
  startedAt: number;
  finishedAt: number;
  events: number;
  facts: number;
  error?: string | null;
}

export interface ConnectorConfig {
  sink: { url?: string };
  sources: { backlog?: BacklogConnection; gdrive?: GdriveConnection };
  /** the shared type layer — ONE per deployment; seeded from the Backlog declarations when empty */
  model: SharedModel;
  /** per-source mappings (bindings onto the shared layer), keyed by source id */
  mappings: Record<string, SourceMapping>;
  pipelines: PipelineDef[];
  /** run history, most-recent first, capped at RUNS_CAP */
  runs: PipelineRun[];
  /** identity candidate pairs a human dismissed, each ordered [low, high] — the candidates endpoint
   *  keeps proposing everything else (a non-identity is not a graph fact, so it lives here) */
  dismissedIdentityPairs?: Array<[number, number]>;
  /** approval candidates a human dismissed, each a [commentId, issueId] pair — same rationale as
   *  dismissedIdentityPairs (a non-approval is not a graph fact, so it lives here) */
  dismissedApprovals?: Array<[number, number]>;
}

/** How many runs the store keeps (append via recordRun evicts the oldest beyond this). */
export const RUNS_CAP = 50;

const HERE = dirname(fileURLToPath(import.meta.url));
const VAR_DIR = process.env.VESICLE_VAR_DIR ?? resolve(HERE, "../../var"); // override for tests/deploys
const FILE = resolve(VAR_DIR, "config.json");

let cache: ConnectorConfig | null = null;

export function loadConfig(): ConnectorConfig {
  if (cache) return cache;
  let raw: Partial<ConnectorConfig> = {};
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as Partial<ConnectorConfig> | null;
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch (e) {
    // a missing file is just the first run; anything else (e.g. corrupt JSON) deserves a warning,
    // because the next save will overwrite whatever is there
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`config store: could not read ${FILE}: ${(e as Error).message} — starting empty`);
    }
  }
  // An empty shared layer is seeded with the Backlog source's static declarations, so the shared
  // Person (etc.) exists for other sources to map onto from the first propose.
  const model: SharedModel = { types: raw.model?.types ?? [], predicates: raw.model?.predicates ?? [] };
  const seeded = model.types.length || model.predicates.length ? model : seedModel();
  cache = {
    sink: raw.sink ?? {},
    sources: raw.sources ?? {},
    model: seeded,
    mappings: raw.mappings ?? {},
    pipelines: raw.pipelines ?? [],
    runs: raw.runs ?? [],
    dismissedIdentityPairs: raw.dismissedIdentityPairs ?? [],
    dismissedApprovals: raw.dismissedApprovals ?? [],
  };
  return cache;
}

/** Mutate the config in memory and persist it atomically (tmp file + rename). */
export function saveConfig(mutate: (cfg: ConnectorConfig) => void): ConnectorConfig {
  const cfg = loadConfig();
  mutate(cfg);
  mkdirSync(VAR_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, FILE);
  return cfg;
}

/** Prepend one run to the history and persist (append-only, most-recent first, capped). */
export function recordRun(run: PipelineRun): void {
  saveConfig((cfg) => {
    cfg.runs.unshift(run);
    if (cfg.runs.length > RUNS_CAP) cfg.runs.length = RUNS_CAP;
  });
}
