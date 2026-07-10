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
const BASE = { Person: 1_000_000_000, Project: 2_000_000_000, Issue: 3_000_000_000, Comment: 4_000_000_000 } as const;
const nid = (kind: keyof typeof BASE, id: number): number => BASE[kind] + id;

// Schema is emitted with every batch. Re-sending a type_def / a same-cardinality pred_def is idempotent
// in the engine, so each webhook stays self-contained and order-independent (defs precede the facts that
// use them within the batch).
const SCHEMA: BatchItem[] = [
  { type_def: { name: "Person" } },
  { type_def: { name: "Project" } },
  { type_def: { name: "Issue" } },
  { type_def: { name: "Comment" } },
  { pred_def: { name: "name", cardinality: "one", domain: "Person", range_value: "text" } },
  { pred_def: { name: "email", cardinality: "one", domain: "Person", range_value: "text" } },
  { pred_def: { name: "project-name", cardinality: "one", domain: "Project", range_value: "text" } },
  { pred_def: { name: "project-key", cardinality: "one", domain: "Project", range_value: "text" } },
  { pred_def: { name: "issue-key", cardinality: "one", domain: "Issue", range_value: "text" } },
  { pred_def: { name: "summary", cardinality: "one", domain: "Issue", range_value: "text" } },
  { pred_def: { name: "status", cardinality: "one", domain: "Issue", range_value: "text" } },
  { pred_def: { name: "assigned-to", cardinality: "one", domain: "Issue", range: "Person" } },
  { pred_def: { name: "in-project", cardinality: "one", domain: "Issue", range: "Project" } },
  { pred_def: { name: "created-by", cardinality: "one", domain: "Issue", range: "Person" } },
  { pred_def: { name: "content", cardinality: "one", domain: "Comment", range_value: "text" } },
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

/** Map one Backlog activity to a self-contained ingest batch. Unknown types return `{items:[], kind:"ignored"}`. */
export function backlogEventToBatch(ev: BacklogWebhook): BacklogBatch {
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
      // Cessation: a cleared field (old value present → new value empty) ends its one-cardinality
      // value with no successor. The engine cannot infer that — the snapshot just omits the field —
      // so emit a close at the event time; as-of reads before it still see the prior value.
      const closed: string[] = [];
      for (const ch of ev.content.changes ?? []) {
        const predicate = CLOSABLE_FIELDS[ch.field];
        if (!predicate || isEmptyValue(ch.old_value) || !isEmptyValue(ch.new_value)) continue;
        closes.push({ close: { subject: issue, predicate, valid_from: at } });
        closed.push(predicate);
      }
      kind = "issue-updated";
      summary = `issue ${keyLabel} updated${ev.content.status ? ` → ${ev.content.status.name}` : ""}${closed.length ? ` (closed ${closed.join(", ")})` : ""}`;
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
