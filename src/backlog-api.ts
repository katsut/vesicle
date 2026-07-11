// Minimal Backlog (Nulab) REST API client for project + webhook management. OAuth only — every call
// authenticates with an OAuth 2.0 bearer token (no long-lived personal API keys).
//
//   GET    /api/v2/projects
//   GET    /api/v2/projects/:projectIdOrKey/webhooks
//   POST   /api/v2/projects/:projectIdOrKey/webhooks   (name, hookUrl, activityTypeIds[])
//   DELETE /api/v2/projects/:projectIdOrKey/webhooks/:id

export interface BacklogApiConfig {
  /** the space host, e.g. example.backlog.com */
  host: string;
  /** OAuth 2.0 access token */
  token: string;
}

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
}

export interface BacklogWebhookRecord {
  id: number;
  name: string;
  description: string;
  hookUrl: string;
  allEvent: boolean;
  activityTypeIds: number[];
}

/** Activity types this connector understands (issue created / updated / commented). */
export const ISSUE_ACTIVITY_TYPES = [1, 2, 3];

function authHeaders(cfg: BacklogApiConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, authorization: `Bearer ${cfg.token}` };
}

async function readJson(r: Response, what: string): Promise<unknown> {
  const text = await r.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  if (!r.ok) {
    const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body);
    throw new Error(`${what} failed (${r.status}): ${detail}`);
  }
  return body;
}

export async function listProjects(cfg: BacklogApiConfig): Promise<BacklogProject[]> {
  const r = await fetch(`https://${cfg.host}/api/v2/projects`, { headers: authHeaders(cfg) });
  return (await readJson(r, "list projects")) as BacklogProject[];
}

export interface BacklogActivity {
  id: number;
  type: number;
  project: { id: number; projectKey: string; name: string };
  content: Record<string, unknown>;
  createdUser: { id: number; name: string; mailAddress?: string | null };
  created: string;
}

/** Poll recent activities for a project (pull, outbound-only — no public webhook endpoint needed).
 *  `minId` returns only activities newer than the last one seen; the shape matches a webhook payload. */
export async function listActivities(
  cfg: BacklogApiConfig,
  opts: { project: string; minId?: number; count?: number; activityTypeIds?: number[]; order?: "asc" | "desc" },
): Promise<BacklogActivity[]> {
  const p = new URLSearchParams();
  for (const id of opts.activityTypeIds ?? ISSUE_ACTIVITY_TYPES) p.append("activityTypeId[]", String(id));
  if (opts.minId != null) p.set("minId", String(opts.minId));
  p.set("count", String(opts.count ?? 100));
  p.set("order", opts.order ?? "asc");
  const url = `https://${cfg.host}/api/v2/projects/${encodeURIComponent(opts.project)}/activities?${p.toString()}`;
  const r = await fetch(url, { headers: authHeaders(cfg) });
  return (await readJson(r, "list activities")) as BacklogActivity[];
}

export interface BacklogStatus {
  id: number;
  name: string;
}

/** A project's status list — resolves the numeric-id strings that activity `changes[]` carry. */
export async function listStatuses(project: string, cfg: BacklogApiConfig): Promise<BacklogStatus[]> {
  const url = `https://${cfg.host}/api/v2/projects/${encodeURIComponent(project)}/statuses`;
  const r = await fetch(url, { headers: authHeaders(cfg) });
  return (await readJson(r, "list statuses")) as BacklogStatus[];
}

export interface BacklogProjectUser {
  id: number;
  name: string;
  mailAddress?: string | null;
}

/** A project's members — resolves the display names that assignee `changes[]` carry back to users. */
export async function listProjectUsers(project: string, cfg: BacklogApiConfig): Promise<BacklogProjectUser[]> {
  const url = `https://${cfg.host}/api/v2/projects/${encodeURIComponent(project)}/users`;
  const r = await fetch(url, { headers: authHeaders(cfg) });
  return (await readJson(r, "list project users")) as BacklogProjectUser[];
}

export async function listWebhooks(project: string, cfg: BacklogApiConfig): Promise<BacklogWebhookRecord[]> {
  const url = `https://${cfg.host}/api/v2/projects/${encodeURIComponent(project)}/webhooks`;
  const r = await fetch(url, { headers: authHeaders(cfg) });
  return (await readJson(r, "list webhooks")) as BacklogWebhookRecord[];
}

export async function registerWebhook(
  opts: { project: string; hookUrl: string; name?: string; description?: string; activityTypeIds?: number[] },
  cfg: BacklogApiConfig,
): Promise<BacklogWebhookRecord> {
  const body = new URLSearchParams();
  body.set("name", opts.name ?? "Vesicle stream");
  body.set("hookUrl", opts.hookUrl);
  if (opts.description) body.set("description", opts.description);
  for (const id of opts.activityTypeIds ?? ISSUE_ACTIVITY_TYPES) body.append("activityTypeIds[]", String(id));
  const url = `https://${cfg.host}/api/v2/projects/${encodeURIComponent(opts.project)}/webhooks`;
  const r = await fetch(url, {
    method: "POST",
    headers: authHeaders(cfg, { "content-type": "application/x-www-form-urlencoded" }),
    body,
  });
  return (await readJson(r, "register webhook")) as BacklogWebhookRecord;
}

export async function deleteWebhook(project: string, id: number, cfg: BacklogApiConfig): Promise<BacklogWebhookRecord> {
  const url = `https://${cfg.host}/api/v2/projects/${encodeURIComponent(project)}/webhooks/${id}`;
  const r = await fetch(url, { method: "DELETE", headers: authHeaders(cfg) });
  return (await readJson(r, "delete webhook")) as BacklogWebhookRecord;
}
