// Google Drive file metadata → StromaDB ingest batch (the structural lane: names, hierarchy,
// ownership, ACL — no document bodies).
//
// Mirrors backlog.ts: one upstream object maps to a *self-contained* batch — schema defs
// (idempotent) + nodes + facts — that streams into the engine's incremental maintenance. Facts carry
// no provenance here; the sink stamps the pipeline id (StromaSink.ingest). No LLM on this path: the
// mapping is fixed, deterministic, token-zero.
//
// Every fact's valid_from is the file's modifiedTime, so one-cardinality attributes (name, folder,
// owner) supersede with valid time and the graph keeps the as-of history of the drive's structure.

import type { BatchItem, FactObject } from "./etl/types.ts";
import { isoToEpoch } from "./backlog.ts";
import { FOLDER_MIME, SHORTCUT_MIME, type DriveFile, type DrivePermission, type DriveUser } from "./gdrive-api.ts";

// --- node ids ------------------------------------------------------------------------------------
//
// Drive ids are opaque strings, so stable numeric node ids come from a deterministic 48-bit hash
// (FNV-1a 64 truncated to 2^48) of the Drive id, placed in per-type bands ABOVE the Backlog ones
// (Person 1e12 … Comment 4e12). A 48-bit hash needs a 2^48-wide band — a 1e12 stride cannot hold it —
// so the Drive bands sit at multiples of 2^48: Document 5·2^48, Folder 6·2^48, Person 7·2^48, plus
// the extracted-entity band 8·2^48 minted by the body lane (see gdrive-extract.ts CLAIM_BAND) and
// the body lane's DocFamily anchor band 9·2^48 (keyed by logical doc id, not a Drive id). The
// highest id (10·2^48 < 2^52) stays far inside JS's 2^53 integers and the engine's u64.
//
// Collision expectation: 2^48 values per band → the birthday bound is ~2^24 ≈ 16.7M ids per type
// before a collision becomes likely, several orders of magnitude beyond any real drive scope.
// Persons key on the Google permissionId when present, else the email address, hashed the same way.
const BAND = {
  Document: 5 * 2 ** 48,
  Folder: 6 * 2 ** 48,
  Person: 7 * 2 ** 48,
  DocFamily: 9 * 2 ** 48,
} as const;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;
const MASK48 = (1n << 48n) - 1n;

/** FNV-1a 64 over the UTF-16 code units, truncated to 48 bits. Shared with the body lane's
 *  extracted-entity ids (gdrive-extract.ts), so every Drive-derived id hashes the same way. */
export function hash48(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & U64;
  }
  return Number(h & MASK48);
}

export const nid = (kind: keyof typeof BAND, driveId: string): number => BAND[kind] + hash48(driveId);

// --- schema --------------------------------------------------------------------------------------
//
// Emitted with every batch (idempotent in the engine), and exported for the shared-layer seed
// (src/model.ts) — the declarations live in exactly one place. Person is the SAME type name the
// Backlog source declares: entity resolution across sources is the point, and the shared `name` /
// `email` predicates are redeclared here identically so a Drive-only batch is still self-contained.
export const SCHEMA: BatchItem[] = [
  { type_def: { name: "Document" } },
  { type_def: { name: "Folder" } },
  { type_def: { name: "Person" } },
  // `name` must carry the same display flag as the Backlog schema — the engine keeps the flag from
  // whichever def line arrived last, so connectors sharing a predicate must agree on it.
  { pred_def: { name: "name", cardinality: "one", domain: "Person", range_value: "text", display: true } },
  { pred_def: { name: "email", cardinality: "one", domain: "Person", range_value: "text" } },
  { pred_def: { name: "doc-name", cardinality: "one", domain: "Document", range_value: "text", display: true } },
  { pred_def: { name: "mime-type", cardinality: "one", domain: "Document", range_value: "text" } },
  { pred_def: { name: "in-folder", cardinality: "one", domain: "Document", range: "Folder" } },
  { pred_def: { name: "folder-name", cardinality: "one", domain: "Folder", range_value: "text", display: true } },
  { pred_def: { name: "parent-folder", cardinality: "one", domain: "Folder", range: "Folder" } },
  { pred_def: { name: "owned-by", cardinality: "one", domain: "Document", range: "Person" } },
  { pred_def: { name: "can-access", cardinality: "many", domain: "Document", range: "Person" } },
  { pred_def: { name: "account-deleted", cardinality: "one", domain: "Person", range_value: "bool" } },
];

// --- ACL → sensitivity label ----------------------------------------------------------------------
//
// The ACL derives the node's ABAC sensitivity tier, deterministic and err-strict (when the ACL is
// unknown, assume the most restricted). Numeric labels follow the existing convention (higher =
// more sensitive; the drive sample slice used 0=public, 1=internal, 2=confidential):
//   1 = internal      — a domain-wide or anyone link grant: broad inside the org
//   2 = confidential  — a group grant, or more than one distinct non-owner principal
//   3 = restricted    — owner only, or owner plus at most one other principal
export const LABEL_INTERNAL = 1;
export const LABEL_CONFIDENTIAL = 2;
export const LABEL_RESTRICTED = 3;

export function sensitivityLabel(permissions: DrivePermission[] | undefined): number {
  if (!permissions) return LABEL_RESTRICTED; // ACL unknown (fetch failed) → strictest
  // The tier reflects EFFECTIVE sharing: a grant held by a deleted account cannot be exercised, so
  // it does not widen the tier (the grant itself stays in the graph as an audit edge).
  const live = permissions.filter((p) => !p.deleted);
  if (live.some((p) => p.type === "domain" || p.type === "anyone")) return LABEL_INTERNAL;
  if (live.some((p) => p.type === "group")) return LABEL_CONFIDENTIAL;
  const nonOwner = new Set(
    live.filter((p) => p.role !== "owner").map((p) => p.id ?? p.emailAddress).filter((k): k is string => !!k),
  );
  return nonOwner.size > 1 ? LABEL_CONFIDENTIAL : LABEL_RESTRICTED;
}

// --- mapping -------------------------------------------------------------------------------------

export interface GdriveBatch {
  /** the ingest batch (schema defs + nodes + facts), empty when the file is not handled */
  items: BatchItem[];
  kind: "document" | "folder" | "ignored";
  summary: string;
  factCount: number;
}

/** Name a shared drive's root Folder node. The root only ever appears as a parent-folder /
 *  in-folder endpoint (the Files API never lists it), so without this batch it renders as a bare
 *  node id. */
export function driveRootBatch(driveId: string, driveName: string, at: number): BatchItem[] {
  const root = nid("Folder", driveId);
  return [
    ...SCHEMA,
    { node: { id: root, type: "Folder" } },
    { fact: { subject: root, predicate: "folder-name", object: { text: driveName }, valid_from: at } },
  ];
}

/** A person's stable key: Google permissionId when present, else the email. Null = unmappable. */
const personKey = (u: { permissionId?: string; id?: string; emailAddress?: string }): string | null =>
  u.permissionId ?? u.id ?? u.emailAddress ?? null;

/** Map one Drive file's metadata to a self-contained ingest batch. Shortcuts must be resolved to
 *  their target BEFORE mapping (gdrive-api hydrateFile) — an unresolved shortcut is ignored, the
 *  shortcut file itself never becomes a node. Removed/trashed files are skipped upstream (v1 emits
 *  no closes for them). */
export function driveFileToBatch(file: DriveFile): GdriveBatch {
  if (file.mimeType === SHORTCUT_MIME) {
    return { items: [], kind: "ignored", summary: `shortcut ${file.id} not resolved — skipped`, factCount: 0 };
  }
  const at = isoToEpoch(file.modifiedTime ?? file.createdTime ?? "");
  const nodes: BatchItem[] = [];
  const facts: BatchItem[] = [];
  const seenNodes = new Set<number>();

  const node = (kind: keyof typeof BAND, driveId: string, label?: number): number => {
    const gid = nid(kind, driveId);
    if (!seenNodes.has(gid)) {
      // the band name doubles as the graph type name (Person is the shared cross-source type)
      nodes.push({ node: label != null ? { id: gid, type: kind, label } : { id: gid, type: kind } });
      seenNodes.add(gid);
    }
    return gid;
  };
  // Person-identity facts pass vf 0 ("always valid"): stamping them with the FILE's modifiedTime
  // would re-assert the same identity under a different valid_from for every file the person
  // appears in, defeating the engine's no-op suppression on re-syncs.
  const fact = (subject: number, predicate: string, object: FactObject, vf: number = at): void => {
    facts.push({ fact: { subject, predicate, object, valid_from: vf } });
  };

  const person = (u: DriveUser | DrivePermission): number | null => {
    const key = personKey(u);
    if (!key) return null;
    const pid = node("Person", key);
    if (u.displayName) fact(pid, "name", { text: u.displayName }, 0);
    if (u.emailAddress) fact(pid, "email", { text: u.emailAddress }, 0);
    return pid;
  };

  const label = sensitivityLabel(file.permissions);
  const displayName = file.name ?? file.id;

  if (file.mimeType === FOLDER_MIME) {
    const folder = node("Folder", file.id, label);
    fact(folder, "folder-name", { text: displayName });
    const parentId = file.parents?.[0];
    if (parentId) fact(folder, "parent-folder", { node: node("Folder", parentId) });
    return {
      items: [...SCHEMA, ...nodes, ...facts],
      kind: "folder",
      summary: `folder "${displayName}" (label ${label})`,
      factCount: facts.length,
    };
  }

  const doc = node("Document", file.id, label);
  fact(doc, "doc-name", { text: displayName });
  if (file.mimeType) fact(doc, "mime-type", { text: file.mimeType });
  const parentId = file.parents?.[0];
  if (parentId) fact(doc, "in-folder", { node: node("Folder", parentId) });
  const owner = file.owners?.[0];
  const ownerId = owner ? person(owner) : null;
  if (ownerId != null) fact(doc, "owned-by", { node: ownerId });
  // The grant edge itself is the audit fact (role detail deferred): one can-access per USER grant.
  // Group/domain/anyone grants have no single Person — they are captured by the sensitivity label.
  let grants = 0;
  for (const perm of file.permissions ?? []) {
    if (perm.type !== "user") continue;
    const pid = person(perm);
    if (pid == null) continue;
    // A deleted grantee stays in the graph (the ACL still carries the grant — a hygiene finding),
    // labeled the way Drive's own UI shows it; the API returns no identity for it.
    if (perm.deleted) {
      fact(pid, "name", { text: "(deleted account)" }, 0);
      fact(pid, "account-deleted", { bool: true }, 0);
    }
    fact(doc, "can-access", { node: pid });
    grants++;
  }
  return {
    items: [...SCHEMA, ...nodes, ...facts],
    kind: "document",
    summary: `document "${displayName}" (label ${label}, ${grants} user grants)`,
    factCount: facts.length,
  };
}
