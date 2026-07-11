// Access-policy conformance: declared sensitivity floors vs observed sharing.
//
// The structural lane records what a document's ACL currently derives (the node's sensitivity
// label — the OBSERVED tier), and the body lane records what the document's extracted claims
// require (`requires-floor` — the DECLARED policy, from the shared layer's predicate floors).
// Their diff is computable deterministically, no LLM: a document whose observed tier is looser
// than its required floor is OVER-SHARED. The gaps surface as a reviewable list, and the human
// verdict is written back as facts on the document — the same review flywheel as the
// decision-authority conformance (src/review.ts), on Document subjects.
//
// The missing-grantee half (someone the policy expects who is absent from the ACL) needs
// role→entitlement declarations and is deliberately out of scope here.

import { hydrateFile, listFiles, type DriveScope, type GdriveApiConfig } from "./gdrive-api.ts";
import { nid, sensitivityLabel } from "./gdrive.ts";
import type { Stroma } from "./stroma.ts";

export type SharingDecision = "confirmed" | "waived";

/** One over-shared document: observed sharing looser than the floor its claims require. */
export interface SharingViolation {
  fileId: string;
  name: string;
  node: number;
  /** ACL-derived tier as of this evaluation (fresh from the Drive API, not the possibly-stale node label) */
  observed: number;
  /** the declared requirement recorded at extraction time */
  required: number;
  review: { decision: SharingDecision; reviewer: string | null; note: string | null } | null;
}

export interface SharingReport {
  /** files examined in the scope (after shortcut resolution) */
  checked: number;
  /** documents carrying a requires-floor (i.e. extracted claims with floored predicates) */
  withFloor: number;
  violations: SharingViolation[];
}

const REVIEW_SCHEMA = [
  `{"pred_def":{"name":"sharing-review","cardinality":"one","domain":"Document","range_value":"text"}}`,
  `{"pred_def":{"name":"sharing-reviewed-by","cardinality":"one","domain":"Document","range_value":"text"}}`,
  `{"pred_def":{"name":"sharing-review-note","cardinality":"one","domain":"Document","range_value":"text"}}`,
].join("\n");

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** The declared floor recorded on a document node, or null (never extracted / no floored claims).
 *  Tolerant of the predicate not being registered yet — null rather than throwing. */
async function requiredFloor(db: Stroma, node: number): Promise<number | null> {
  try {
    const j = await db.query({ op: "point", subject: node, predicate: "requires-floor" });
    const one = j.one as { int?: number } | null;
    return one?.int ?? null;
  } catch (e) {
    if ((e as Error).message.includes("unknown predicate")) return null;
    throw e;
  }
}

/** The human verdict on a document's sharing, if any. */
export async function fetchSharingReview(
  db: Stroma,
  node: number,
): Promise<SharingViolation["review"]> {
  let decision: SharingDecision | null;
  try {
    decision = (await db.pointText(node, "sharing-review")) as SharingDecision | null;
  } catch {
    return null; // predicate not registered yet ⇒ nothing has been reviewed
  }
  if (!decision) return null;
  const [reviewer, note] = await Promise.all([
    db.pointText(node, "sharing-reviewed-by"),
    db.pointText(node, "sharing-review-note"),
  ]);
  return { decision, reviewer, note };
}

/** Evaluate the scope: fresh observed tiers from the Drive API vs the recorded requires-floor of
 *  each document node. Deterministic, token-zero. */
export async function evaluateSharing(
  cfg: GdriveApiConfig,
  scope: DriveScope,
  db: Stroma,
): Promise<SharingReport> {
  await db.ensureAuthed();
  const violations: SharingViolation[] = [];
  let checked = 0;
  let withFloor = 0;
  let pageToken: string | undefined;
  do {
    const page = await listFiles(cfg, { scope, pageToken });
    for (const raw of page.files) {
      const file = await hydrateFile(cfg, raw);
      checked++;
      const node = nid("Document", file.id);
      const required = await requiredFloor(db, node);
      if (required == null) continue;
      withFloor++;
      const observed = sensitivityLabel(file.permissions);
      if (observed >= required) continue;
      violations.push({
        fileId: file.id,
        name: file.name ?? file.id,
        node,
        observed,
        required,
        review: await fetchSharingReview(db, node),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { checked, withFloor, violations };
}

/** Persist a human verdict on a document's sharing as human-asserted facts (the review flywheel). */
export async function recordSharingReview(
  db: Stroma,
  r: { node: number; decision: SharingDecision; reviewer: string; note?: string },
): Promise<void> {
  const facts = [
    `{"fact":{"subject":${r.node},"predicate":"sharing-review","object":{"text":"${r.decision}"}}}`,
    `{"fact":{"subject":${r.node},"predicate":"sharing-reviewed-by","object":{"text":"${esc(r.reviewer)}"}}}`,
  ];
  if (r.note) facts.push(`{"fact":{"subject":${r.node},"predicate":"sharing-review-note","object":{"text":"${esc(r.note)}"}}}`);
  await db.ensureAuthed();
  await db.ingest([REVIEW_SCHEMA, ...facts].join("\n"));
}
