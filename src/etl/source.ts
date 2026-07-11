// Source: where batches come from. A source normalizes its upstream — webhook pushes and/or polled
// activities — into neutral events and maps each event to a self-contained ingest batch, so the
// server wires sources to the sink without knowing any connector detail. BacklogSource is a thin
// adapter over the existing backlog.ts / backlog-api.ts functions (the OAuth dance itself stays in
// the server routes — the Source contract is about ingestion).

import { backlogEventToBatch, type BacklogLookups, type BacklogUser, type BacklogWebhook } from "../backlog.ts";
import {
  ISSUE_ACTIVITY_TYPES,
  listActivities,
  listProjects,
  listProjectUsers,
  listStatuses,
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

  // Per-project lookups for real activity payloads, whose changes[] carry status ids and user display
  // names instead of snapshot objects. Fetched once per scope and cached; a refresh only happens when
  // the scope changes (statuses/members are near-static — a stale hit degrades to the raw value).
  private lookupScope: string | null = null;
  private statusById = new Map<string, string>();
  private userByName = new Map<string, BacklogUser>();

  /** Load the scope's status list + member list into the lookup cache (no-op when already loaded). */
  async ensureLookups(conn: SourceConnection, scope: string): Promise<void> {
    if (this.lookupScope === scope && this.statusById.size) return;
    const auth = { host: conn.host, token: conn.accessToken };
    const [statuses, users] = await Promise.all([listStatuses(scope, auth), listProjectUsers(scope, auth)]);
    this.statusById = new Map(statuses.map((s) => [String(s.id), s.name]));
    this.userByName = new Map(users.map((u) => [u.name, { id: u.id, name: u.name, mailAddress: u.mailAddress }]));
    this.lookupScope = scope;
  }

  private lookups(): BacklogLookups {
    return {
      statusName: (id) => this.statusById.get(id),
      userByName: (name) => this.userByName.get(name),
    };
  }

  webhookToEvents(payload: unknown): SourceEvent[] | null {
    const ev = payload as BacklogWebhook | undefined;
    if (!ev || typeof ev.type !== "number" || !ev.content || !ev.project) return null;
    return [{ id: 0, payload: ev }];
  }

  /** `scope` is the Backlog project id or key. */
  async poll(conn: SourceConnection, scope: string, cursor: number): Promise<{ events: SourceEvent[]; nextCursor: number }> {
    try {
      await this.ensureLookups(conn, scope);
    } catch (e) {
      // polling continues without lookups — status diffs then land as raw id strings
      console.log(`  backlog lookups unavailable (${scope}): ${(e as Error).message}`);
    }
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
    return backlogEventToBatch(event.payload as BacklogWebhook, this.lookups());
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
