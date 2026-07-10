// Source: where batches come from. A source normalizes its upstream — webhook pushes and/or polled
// activities — into neutral events and maps each event to a self-contained ingest batch, so the
// server wires sources to the sink without knowing any connector detail. BacklogSource is a thin
// adapter over the existing backlog.ts / backlog-api.ts functions (the OAuth dance itself stays in
// the server routes — the Source contract is about ingestion).

import { backlogEventToBatch, type BacklogWebhook } from "../backlog.ts";
import {
  ISSUE_ACTIVITY_TYPES,
  listActivities,
  listProjects,
  registerWebhook,
  type BacklogProject,
  type BacklogWebhookRecord,
} from "../backlog-api.ts";
import type { BatchItem } from "./types.ts";

export type IngestMode = "webhook" | "poll" | "one-shot";

/** What a source needs to reach its upstream API (a subset of its config-store connection record). */
export interface SourceConnection {
  /** the upstream host, e.g. example.backlog.com */
  host: string;
  /** OAuth 2.0 bearer token */
  accessToken: string;
}

/** One upstream activity, normalized: the source's own event id (the poll cursor advances past it;
 *  0 when the transport carries none) plus the source-native payload `eventToBatch` consumes. */
export interface SourceEvent {
  id: number;
  payload: unknown;
}

/** One event mapped to ingest items, plus logging metadata. `items` is empty when the event is
 *  recognized but not handled. */
export interface SourceBatch {
  items: BatchItem[];
  kind: string;
  summary: string;
  factCount: number;
}

export interface Source {
  /** e.g. "backlog" — keys the runtime poller and the config-store entry */
  id: string;
  label: string;
  modes: IngestMode[];
  /** Parse a pushed webhook body into events; null when the payload is not this source's shape. */
  webhookToEvents(payload: unknown): SourceEvent[] | null;
  /** Pull events in `scope` newer than `cursor` (the last seen event id; 0 = from the beginning). */
  poll(conn: SourceConnection, scope: string, cursor: number): Promise<{ events: SourceEvent[]; nextCursor: number }>;
  /** Map one event to a self-contained ingest batch. */
  eventToBatch(event: SourceEvent): SourceBatch;
}

export class BacklogSource implements Source {
  readonly id = "backlog";
  readonly label = "Backlog";
  readonly modes: IngestMode[] = ["webhook", "poll"];

  webhookToEvents(payload: unknown): SourceEvent[] | null {
    const ev = payload as BacklogWebhook | undefined;
    if (!ev || typeof ev.type !== "number" || !ev.content || !ev.project) return null;
    return [{ id: 0, payload: ev }];
  }

  /** `scope` is the Backlog project id or key. */
  async poll(conn: SourceConnection, scope: string, cursor: number): Promise<{ events: SourceEvent[]; nextCursor: number }> {
    const acts = await listActivities(
      { host: conn.host, token: conn.accessToken },
      { project: scope, minId: cursor || undefined, count: 100, order: "asc", activityTypeIds: ISSUE_ACTIVITY_TYPES },
    );
    return {
      events: acts.map((a) => ({ id: a.id, payload: a })),
      nextCursor: acts.reduce((m, a) => Math.max(m, a.id), cursor),
    };
  }

  /** A polled activity has the same shape as a webhook payload, so one mapping consumes both. */
  eventToBatch(event: SourceEvent): SourceBatch {
    return backlogEventToBatch(event.payload as BacklogWebhook);
  }

  // --- connector management (Backlog-specific, beyond the ingest contract): the connect page's
  // project picker and webhook install go through these, so routes never call backlog-api directly.

  listProjects(conn: SourceConnection): Promise<BacklogProject[]> {
    return listProjects({ host: conn.host, token: conn.accessToken });
  }

  installWebhook(conn: SourceConnection, opts: { project: string; hookUrl: string }): Promise<BacklogWebhookRecord> {
    return registerWebhook(
      { project: opts.project, hookUrl: opts.hookUrl, name: "Vesicle stream", description: "issue events → StromaDB", activityTypeIds: ISSUE_ACTIVITY_TYPES },
      { host: conn.host, token: conn.accessToken },
    );
  }
}
