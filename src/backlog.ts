// Backlog (Nulab) webhook → StromaDB ingest batch.
//
// Backlog is a SaaS, not a database, so the stream is its webhook: it POSTs a JSON activity the moment
// something happens (issue added / updated / commented). This maps one such activity into a *self-
// contained* ingest batch — schema defs (idempotent) + nodes + facts + closes — that streams straight
// into the engine's incremental maintenance. Facts carry no provenance here: the sink stamps each one
// with the id of the pipeline that ingested it (StromaSink.ingest). The LLM is NOT on this path; the
// source→fact mapping below was decided once (authoring), the runtime is deterministic and token-zero.
//
// `status` (and the other issue attributes) are one-cardinality with `valid_from = the event time`, so
// each update supersedes the prior value and *keeps the interval* — you can later ask the engine for the
// status as-of any instant. That valid-time history is the point of streaming into StromaDB rather than
// overwriting a row.

import type { BatchItem, FactObject } from "./etl/types.ts";

/** The subset of a Backlog webhook activity we read. Backlog sends more; extra fields are ignored. */
export interface BacklogUser {
  id: number;
  name: string;
  mailAddress?: string | null;
}
/** One field diff on an issue-updated activity. Backlog sends string values ("" = empty). */
export interface BacklogChange {
  field: string;
  old_value?: string | null;
  new_value?: string | null;
}
export interface BacklogWebhook {
  /** activity type: 1 = issue created, 2 = issue updated, 3 = issue commented (others: ignored here) */
  type: number;
  project: { id: number; projectKey: string; name: string };
  content: {
    id: number;
    key_id?: number;
    summary?: string;
    status?: { id: number; name: string } | null;
    assignee?: BacklogUser | null;
    comment?: { id: number; content: string } | null;
    changes?: BacklogChange[];
  };
  createdUser: BacklogUser;
  /** ISO-8601, e.g. "2026-07-07T12:34:56Z" */
  created: string;
}

export interface BacklogBatch {
  /** the ingest batch (schema defs + nodes + facts + closes), empty when the event type is not handled */
  items: BatchItem[];
  /** which activity we mapped, for logging */
  kind: "issue-created" | "issue-updated" | "issue-commented" | "ignored";
  /** one-line human summary */
  summary: string;
  factCount: number;
}

// Node-id namespaces: Backlog ids are per-entity, so offset by type to keep them globally unique.
// The stride is 1e12: real Backlog global ids run past 1e9, so a 1e9 stride overflowed entities into
// the next type's band (and could collide two entities on one node id). 4e12 stays far inside both
// JS's 2^53 integers and the engine's u64.
const BASE = { Person: 1_000_000_000_000, Project: 2_000_000_000_000, Issue: 3_000_000_000_000, Comment: 4_000_000_000_000 } as const;
const nid = (kind: keyof typeof BASE, id: number): number => BASE[kind] + id;

// Schema is emitted with every batch. Re-sending a type_def / a same-cardinality pred_def is idempotent
// in the engine, so each webhook stays self-contained and order-independent (defs precede the facts that
// use them within the batch). Exported: the shared type layer seeds itself from these declarations
// (src/model.ts), so the list lives in exactly one place.
export const SCHEMA: BatchItem[] = [
  { type_def: { name: "Person" } },
  { type_def: { name: "Project" } },
  { type_def: { name: "Issue" } },
  { type_def: { name: "Comment" } },
  { pred_def: { name: "name", cardinality: "one", domain: "Person", range_value: "text", display: true } },
  { pred_def: { name: "email", cardinality: "one", domain: "Person", range_value: "text" } },
  { pred_def: { name: "project-name", cardinality: "one", domain: "Project", range_value: "text", display: true } },
  { pred_def: { name: "project-key", cardinality: "one", domain: "Project", range_value: "text" } },
  { pred_def: { name: "issue-key", cardinality: "one", domain: "Issue", range_value: "text" } },
  { pred_def: { name: "summary", cardinality: "one", domain: "Issue", range_value: "text", display: true } },
  { pred_def: { name: "status", cardinality: "one", domain: "Issue", range_value: "text" } },
  { pred_def: { name: "assigned-to", cardinality: "one", domain: "Issue", range: "Person" } },
  { pred_def: { name: "in-project", cardinality: "one", domain: "Issue", range: "Project" } },
  { pred_def: { name: "created-by", cardinality: "one", domain: "Issue", range: "Person" } },
  { pred_def: { name: "content", cardinality: "one", domain: "Comment", range_value: "text", display: true } },
  { pred_def: { name: "on-issue", cardinality: "one", domain: "Comment", range: "Issue" } },
  { pred_def: { name: "commented-by", cardinality: "one", domain: "Comment", range: "Person" } },
];

/** ISO-8601 → epoch seconds (the engine's valid_from), or 0 when unparseable. */
export function isoToEpoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// Which changes[].field values map to a cardinality-one issue predicate this connector emits. Only
// these can be *closed* when cleared — the snapshot emission above covers replacement, but a value
// ending with no successor (assignee removed, summary/status blanked) is invisible to it: the field
// is simply absent from the payload. Backlog names the assignee field "assigner" in change entries;
// "assignee" is accepted as an alias. Fields the mapping never emits (milestone, priority, …) have
// no predicate to close and are ignored.
const CLOSABLE_FIELDS: Record<string, string> = {
  assigner: "assigned-to",
  assignee: "assigned-to",
  summary: "summary",
  status: "status",
};

const isEmptyValue = (v: string | null | undefined): boolean => v == null || String(v).trim() === "";

/** Lookups for real activity payloads. Webhook fixtures carry snapshot objects (`content.status`,
 *  `content.assignee`); real polled activities carry only field diffs — `changes[]` with the status
 *  as a numeric-id string and the assignee as a display name. These resolve them back to values the
 *  mapping can emit (status id → name; user name → the user, so a Person node id can be minted). */
export interface BacklogLookups {
  statusName(id: string): string | undefined;
  userByName(name: string): BacklogUser | undefined;
}

/** Map one Backlog activity to a self-contained ingest batch. Unknown types return `{items:[], kind:"ignored"}`. */
export function backlogEventToBatch(ev: BacklogWebhook, lookups?: BacklogLookups): BacklogBatch {
  const at = isoToEpoch(ev.created);
  const nodes: BatchItem[] = [];
  const facts: BatchItem[] = [];
  const closes: BatchItem[] = [];
  const seenNodes = new Set<number>();

  const node = (kind: keyof typeof BASE, id: number): number => {
    const gid = nid(kind, id);
    if (!seenNodes.has(gid)) {
      nodes.push({ node: { id: gid, type: kind } });
      seenNodes.add(gid);
    }
    return gid;
  };
  const fact = (subject: number, predicate: string, object: FactObject): void => {
    facts.push({ fact: { subject, predicate, object, valid_from: at } });
  };

  const person = (u: BacklogUser): number => {
    const pid = node("Person", u.id);
    fact(pid, "name", { text: u.name });
    if (u.mailAddress) fact(pid, "email", { text: u.mailAddress });
    return pid;
  };

  // Project (always present on an issue activity)
  const proj = node("Project", ev.project.id);
  fact(proj, "project-name", { text: ev.project.name });
  fact(proj, "project-key", { text: ev.project.projectKey });

  const author = person(ev.createdUser);

  // Issue snapshot — emitted for create AND update; one-cardinality facts supersede with valid-time,
  // so re-emitting the current values at the new event time builds the as-of history.
  const emitIssue = (): number => {
    const c = ev.content;
    const issue = node("Issue", c.id);
    if (c.key_id != null) fact(issue, "issue-key", { text: `${ev.project.projectKey}-${c.key_id}` });
    if (c.summary != null) fact(issue, "summary", { text: c.summary });
    if (c.status) fact(issue, "status", { text: c.status.name });
    fact(issue, "in-project", { node: proj });
    if (c.assignee) fact(issue, "assigned-to", { node: person(c.assignee) });
    fact(issue, "created-by", { node: author });
    return issue;
  };

  let kind: BacklogBatch["kind"];
  let summary: string;
  const keyLabel = ev.content.key_id != null ? `${ev.project.projectKey}-${ev.content.key_id}` : `#${ev.content.id}`;

  switch (ev.type) {
    case 1: {
      emitIssue();
      kind = "issue-created";
      summary = `issue ${keyLabel} created by ${ev.createdUser.name}`;
      break;
    }
    case 2: {
      const issue = emitIssue();
      // The update's substance is in changes[] — real polled activities carry ONLY these diffs (no
      // snapshot objects), so this loop is what turns a real update into facts.
      const closed: string[] = [];
      const changed: string[] = [];
      for (const ch of ev.content.changes ?? []) {
        const predicate = CLOSABLE_FIELDS[ch.field];
        if (!predicate) continue;
        // Cessation: a cleared field (old value present → new value empty) ends its one-cardinality
        // value with no successor. The engine cannot infer that — the payload just omits the field —
        // so emit a close at the event time; as-of reads before it still see the prior value.
        if (!isEmptyValue(ch.old_value) && isEmptyValue(ch.new_value)) {
          closes.push({ close: { subject: issue, predicate, valid_from: at } });
          closed.push(predicate);
          continue;
        }
        if (isEmptyValue(ch.new_value)) continue;
        const v = String(ch.new_value);
        // Value-carrying diff — only when the snapshot didn't already emit this predicate, so the
        // webhook path (which carries both) doesn't double-write.
        if (predicate === "status" && !ev.content.status) {
          const name = lookups?.statusName(v) ?? v; // unresolved id string still beats dropping the change
          fact(issue, "status", { text: name });
          changed.push(`status → ${name}`);
        } else if (predicate === "assigned-to" && !ev.content.assignee) {
          // the diff carries a display name; only a resolved user can mint the Person node id
          const u = lookups?.userByName(v);
          if (u) {
            fact(issue, "assigned-to", { node: person(u) });
            changed.push(`assigned-to → ${u.name}`);
          }
        } else if (predicate === "summary" && ev.content.summary == null) {
          fact(issue, "summary", { text: v });
          changed.push("summary");
        }
      }
      kind = "issue-updated";
      const statusNote = ev.content.status ? ` → ${ev.content.status.name}` : "";
      const diffNote = changed.length ? ` (${changed.join(", ")})` : "";
      const closeNote = closed.length ? ` (closed ${closed.join(", ")})` : "";
      summary = `issue ${keyLabel} updated${statusNote}${diffNote}${closeNote}`;
      break;
    }
    case 3: {
      const issue = emitIssue();
      const cm = ev.content.comment;
      if (cm) {
        const comment = node("Comment", cm.id);
        fact(comment, "content", { text: cm.content });
        fact(comment, "on-issue", { node: issue });
        fact(comment, "commented-by", { node: author });
      }
      kind = "issue-commented";
      summary = `comment on ${keyLabel} by ${ev.createdUser.name}`;
      break;
    }
    default:
      return { items: [], kind: "ignored", summary: `unhandled activity type ${ev.type}`, factCount: 0 };
  }

  return { items: [...SCHEMA, ...nodes, ...facts, ...closes], kind, summary, factCount: facts.length };
}
