// Minimal Google Drive v3 REST client for the structural lane (metadata + permissions) and the body
// lane's content fetches. OAuth only — every call authenticates with an OAuth 2.0 bearer token
// (mirrors backlog-api.ts: plain fetch, no SDK).
//
//   GET /drive/v3/files                    (scope listing — the first-poll full walk)
//   GET /drive/v3/files/:id                (shortcut target / single-file metadata)
//   GET /drive/v3/files/:id/permissions    (shared-drive items omit inline permissions — the fallback)
//   GET /drive/v3/changes/startPageToken   (the poll cursor's origin)
//   GET /drive/v3/changes                  (incremental poll — the cursor is an opaque STRING token)
//   GET /drive/v3/drives                   (shared drives, for the scope picker)
//   GET /drive/v3/files/:id/export         (Google Doc body → text/plain, body lane)
//   GET /drive/v3/files/:id?alt=media      (binary bytes — PDFs, body lane; capped)

export interface GdriveApiConfig {
  /** OAuth 2.0 access token */
  token: string;
}

/** What a lane reads: one folder's children, one shared drive, or the user's My Drive corpus. */
export type DriveScope = { kind: "folder"; id: string } | { kind: "drive"; id: string } | { kind: "my-drive" };

export interface DrivePermission {
  id?: string;
  /** user | group | domain | anyone */
  type?: string;
  /** owner | organizer | fileOrganizer | writer | commenter | reader */
  role?: string;
  emailAddress?: string;
  displayName?: string;
  domain?: string;
  allowFileDiscovery?: boolean;
  /** the grantee account has been deleted — the grant remains in the ACL but cannot be exercised */
  deleted?: boolean;
}

export interface DriveUser {
  emailAddress?: string;
  displayName?: string;
  permissionId?: string;
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  /** set on changes-feed files; listings exclude trash via q */
  trashed?: boolean;
  /** ISO-8601 */
  modifiedTime?: string;
  createdTime?: string;
  owners?: DriveUser[];
  parents?: string[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
  /** inline only on My Drive items; shared-drive items need fetchPermissions */
  permissions?: DrivePermission[];
}

export interface DriveChange {
  fileId?: string;
  removed?: boolean;
  file?: DriveFile;
}

export interface SharedDrive {
  id: string;
  name: string;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
export const DOC_MIME = "application/vnd.google-apps.document";
export const SLIDES_MIME = "application/vnd.google-apps.presentation";
export const PDF_MIME = "application/pdf";
export const WORD_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const API = "https://www.googleapis.com/drive/v3";
const FILE_FIELDS =
  "id,name,mimeType,trashed,modifiedTime,createdTime,owners(emailAddress,displayName,permissionId),parents,shortcutDetails,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,deleted)";

function authHeaders(cfg: GdriveApiConfig): Record<string, string> {
  return { authorization: `Bearer ${cfg.token}` };
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
    const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    throw new Error(`${what} failed (${r.status}): ${detail}`);
  }
  return body;
}

async function get(cfg: GdriveApiConfig, path: string, params: URLSearchParams, what: string): Promise<unknown> {
  const r = await fetch(`${API}${path}?${params.toString()}`, { headers: authHeaders(cfg) });
  return readJson(r, what);
}

/** One page of the scope's files. Folder scope lists the folder's DIRECT children (`'<id>' in parents`);
 *  drive scope lists a whole shared drive; my-drive lists the user corpus. Trashed files are excluded. */
export async function listFiles(
  cfg: GdriveApiConfig,
  opts: { scope: DriveScope; pageToken?: string },
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const p = new URLSearchParams({
    pageSize: "100",
    fields: `nextPageToken,files(${FILE_FIELDS})`,
  });
  if (opts.scope.kind === "folder") {
    p.set("q", `'${opts.scope.id.replace(/'/g, "\\'")}' in parents and trashed=false`);
    // a folder may live on a shared drive — include both corpora
    p.set("includeItemsFromAllDrives", "true");
    p.set("supportsAllDrives", "true");
  } else if (opts.scope.kind === "drive") {
    p.set("q", "trashed=false");
    p.set("corpora", "drive");
    p.set("driveId", opts.scope.id);
    p.set("includeItemsFromAllDrives", "true");
    p.set("supportsAllDrives", "true");
  } else {
    p.set("q", "trashed=false");
  }
  if (opts.pageToken) p.set("pageToken", opts.pageToken);
  const j = (await get(cfg, "/files", p, "list files")) as { files?: DriveFile[]; nextPageToken?: string };
  return { files: j.files ?? [], nextPageToken: j.nextPageToken };
}

/** One file's metadata (same field set as the listing) — used to resolve shortcut targets. */
export async function getFile(cfg: GdriveApiConfig, fileId: string): Promise<DriveFile> {
  const p = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
  return (await get(cfg, `/files/${encodeURIComponent(fileId)}`, p, "get file")) as DriveFile;
}

/** Per-file permissions.list — the fallback for shared-drive items, whose files.list response
 *  carries no inline `permissions`. Pages until exhausted (ACLs are small; usually one page). */
export async function fetchPermissions(cfg: GdriveApiConfig, fileId: string): Promise<DrivePermission[]> {
  const out: DrivePermission[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({
      pageSize: "100",
      fields: "nextPageToken,permissions(id,type,role,emailAddress,displayName,domain,allowFileDiscovery,deleted)",
      supportsAllDrives: "true",
    });
    if (pageToken) p.set("pageToken", pageToken);
    const j = (await get(cfg, `/files/${encodeURIComponent(fileId)}/permissions`, p, "list permissions")) as {
      permissions?: DrivePermission[];
      nextPageToken?: string;
    };
    out.push(...(j.permissions ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

/** The Changes-API cursor origin: everything after this token is "new". Fetched BEFORE the initial
 *  full listing so changes made during the walk are not lost. */
export async function getStartPageToken(cfg: GdriveApiConfig, driveId?: string): Promise<string> {
  const p = new URLSearchParams({ supportsAllDrives: "true" });
  if (driveId) p.set("driveId", driveId);
  const j = (await get(cfg, "/changes/startPageToken", p, "get start page token")) as { startPageToken?: string };
  if (!j.startPageToken) throw new Error("get start page token: no startPageToken in response");
  return j.startPageToken;
}

/** One page of changes since `pageToken`. `nextPageToken` = more pages now; `newStartPageToken` =
 *  caught up, poll again later from there. `removed` changes carry no file object. */
export async function listChanges(
  cfg: GdriveApiConfig,
  pageToken: string,
  driveId?: string,
): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
  const p = new URLSearchParams({
    pageToken,
    pageSize: "100",
    fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
  });
  if (driveId) p.set("driveId", driveId);
  const j = (await get(cfg, "/changes", p, "list changes")) as {
    changes?: DriveChange[];
    nextPageToken?: string;
    newStartPageToken?: string;
  };
  return { changes: j.changes ?? [], nextPageToken: j.nextPageToken, newStartPageToken: j.newStartPageToken };
}

/** Shared drives the user can see — the scope picker's list (plus a "My Drive" entry the UI adds). */
export async function listDrives(cfg: GdriveApiConfig): Promise<SharedDrive[]> {
  const out: SharedDrive[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ pageSize: "100", fields: "nextPageToken,drives(id,name)" });
    if (pageToken) p.set("pageToken", pageToken);
    const j = (await get(cfg, "/drives", p, "list drives")) as { drives?: SharedDrive[]; nextPageToken?: string };
    out.push(...(j.drives ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return out;
}

/** A Google Doc's body exported as plain text (a Doc has no downloadable bytes — export converts).
 *  Google caps exports at 10 MB of converted content; over-cap and permission errors surface as-is. */
export async function exportDoc(cfg: GdriveApiConfig, fileId: string): Promise<string> {
  const p = new URLSearchParams({ mimeType: "text/plain" });
  const r = await fetch(`${API}/files/${encodeURIComponent(fileId)}/export?${p.toString()}`, { headers: authHeaders(cfg) });
  const text = await r.text();
  if (!r.ok) throw new Error(`export doc failed (${r.status}): ${text.slice(0, 300)}`);
  return text;
}

/** A Slides deck exported as PDF, base64 — decks carry layout/tables the LLM reads natively from
 *  PDF, so they ride the same extraction path as downloaded PDFs. Same size cap as downloads. */
export async function exportPdf(cfg: GdriveApiConfig, fileId: string): Promise<{ base64: string; bytes: number }> {
  const p = new URLSearchParams({ mimeType: "application/pdf" });
  const r = await fetch(`${API}/files/${encodeURIComponent(fileId)}/export?${p.toString()}`, { headers: authHeaders(cfg) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`export pdf failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`exported PDF is ${(buf.byteLength / (1024 * 1024)).toFixed(1)} MB — larger than the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB extraction cap`);
  }
  return { base64: buf.toString("base64"), bytes: buf.byteLength };
}

/** The body lane's per-file size cap: a document bound for a single LLM call, not an archive sync. */
export const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;

/** A binary file's bytes (`alt=media`) as base64 — the body lane's PDF fetch. Capped at
 *  MAX_DOWNLOAD_BYTES: rejected up front when the response declares its length, or after the read
 *  when it doesn't (chunked). */
export async function downloadFile(cfg: GdriveApiConfig, fileId: string): Promise<{ base64: string; bytes: number }> {
  const p = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const r = await fetch(`${API}/files/${encodeURIComponent(fileId)}?${p.toString()}`, { headers: authHeaders(cfg) });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`download failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const overCap = (n: number) =>
    new Error(`file is ${(n / (1024 * 1024)).toFixed(1)} MB — larger than the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB extraction cap`);
  const declared = Number(r.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw overCap(declared);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw overCap(buf.byteLength);
  return { base64: buf.toString("base64"), bytes: buf.byteLength };
}

/** A shortcut's target metadata; a non-shortcut (or a broken shortcut) comes back unchanged.
 *  The mapping follows shortcuts to their target — the shortcut file itself is never a node. */
export async function resolveShortcut(cfg: GdriveApiConfig, file: DriveFile): Promise<DriveFile> {
  if (file.mimeType !== SHORTCUT_MIME) return file;
  const targetId = file.shortcutDetails?.targetId;
  if (!targetId) return file;
  return getFile(cfg, targetId);
}

/** Extract a folder id from a pasted Drive folder URL, or pass a bare id through. Accepted forms:
 *  …/drive/folders/<id>, …/drive/u/0/folders/<id>, …?id=<id>, or the raw id itself. */
export function parseFolderId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const fromPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(s);
  if (fromPath) return fromPath[1]!;
  try {
    const u = new URL(s);
    const idParam = u.searchParams.get("id");
    if (idParam && /^[A-Za-z0-9_-]+$/.test(idParam)) return idParam;
    return null; // a URL, but no folder id in it
  } catch {
    // not a URL — accept a bare Drive id
    return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
  }
}

/** A file ready for mapping: shortcuts resolved to their target, and — when the listing carried no
 *  inline ACL (shared-drive items) — permissions fetched per file. A permission fetch failure leaves
 *  `permissions` unset, which the mapping treats as the STRICTEST tier (err strict, never leak). */
export async function hydrateFile(cfg: GdriveApiConfig, file: DriveFile): Promise<DriveFile> {
  let f = file;
  if (f.mimeType === SHORTCUT_MIME) {
    try {
      f = await resolveShortcut(cfg, f);
    } catch (e) {
      console.log(`  gdrive: shortcut ${f.id} target unresolvable: ${(e as Error).message}`);
      return f; // still a shortcut — the mapping ignores it
    }
  }
  if (!f.permissions) {
    try {
      f = { ...f, permissions: await fetchPermissions(cfg, f.id) };
    } catch (e) {
      console.log(`  gdrive: permissions unavailable for ${f.id} — labeling strict: ${(e as Error).message}`);
    }
  }
  return f;
}
