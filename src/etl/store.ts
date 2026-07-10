// Persisted connector config — var/config.json. Runtime state, not code: the sink URL, one connection
// per source (OAuth tokens live here, so var/ is git-ignored), and pipelines (kept empty until
// pipeline definitions land). Loaded once into an in-memory cache; every save writes a tmp file and
// renames it into place, so a crash never leaves a torn file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** The saved Backlog connection: the OAuth grant plus the last project picked for streaming. */
export interface BacklogConnection {
  /** the space host, e.g. example.backlog.com */
  host: string;
  accessToken: string;
  refreshToken: string;
  /** unix-ms expiry of the access token */
  expiresAt: number;
  projectId?: number;
  projectKey?: string;
}

export interface ConnectorConfig {
  sink: { url?: string };
  sources: { backlog?: BacklogConnection };
  /** pipeline definitions — kept empty for now */
  pipelines: unknown[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const VAR_DIR = resolve(HERE, "../../var");
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
  cache = { sink: raw.sink ?? {}, sources: raw.sources ?? {}, pipelines: raw.pipelines ?? [] };
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
