// Minimal HTTP client for a running stroma-serve. No driver — plain JSON over fetch, exactly the
// surface an agent or app uses.

export class Stroma {
  private cookie: string | null = null;
  private token = process.env.STROMA_API_TOKEN ?? null;

  constructor(private base = process.env.STROMA_URL ?? "http://127.0.0.1:7687") {}

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/health`);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Preferred programmatic auth (stromadb #100): send the API token as a bearer header — no
   *  login/cookie round-trip. Set STROMA_API_TOKEN and start stroma-serve with the same --api-token. */
  useToken(token = process.env.STROMA_API_TOKEN): void {
    this.token = token ?? null;
  }

  /** Fallback auth: the browser session-cookie flow, for a server without an API token configured. */
  async login(user = process.env.STROMA_ADMIN_USER ?? "admin", password = process.env.STROMA_ADMIN_PASSWORD ?? "password"): Promise<void> {
    const r = await fetch(`${this.base}/login`, { method: "POST", body: JSON.stringify({ user, password }) });
    if (!r.ok) throw new Error(`login failed: ${r.status}`);
    const set = r.headers.getSetCookie?.() ?? [];
    const tok = set.map((c) => c.split(";")[0]).find((c) => c?.startsWith("stroma_session="));
    if (!tok) throw new Error("login: no session cookie returned");
    this.cookie = tok;
  }

  /** True once this client can authenticate (token set, or logged in). */
  async ensureAuthed(): Promise<void> {
    if (this.token || this.cookie) return;
    await this.login();
  }

  private headers(): Record<string, string> {
    if (this.token) return { authorization: `Bearer ${this.token}` };
    return this.cookie ? { cookie: this.cookie } : {};
  }

  /** Parse a response body as JSON, but degrade to a clear message when the server returns an empty
   *  or non-JSON body (e.g. a 500 from a panicked worker) instead of throwing "Unexpected end of JSON
   *  input". */
  private async readJson(r: Response, what: string): Promise<Record<string, unknown>> {
    const text = await r.text();
    if (!text.trim()) {
      throw new Error(r.ok ? `${what}: empty response from stroma-serve` : `${what} failed (${r.status}) — empty response from stroma-serve`);
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${what} failed (${r.status}): ${text.slice(0, 200)}`);
    }
    if (!r.ok) throw new Error(`${what} failed: ${JSON.stringify(j)}`);
    return j;
  }

  /** Clear the whole database (opt-in on the server via --allow-reset). Best-effort: a 403 (reset
   *  disabled) is ignored so apply still works against a persistent graph. */
  async reset(): Promise<void> {
    try {
      await fetch(`${this.base}/reset`, { method: "POST", headers: this.headers() });
    } catch {
      // network error → let the subsequent ingest surface it
    }
  }

  /** POST an NDJSON body to /ingest (one durable group-commit fsync for the whole body). */
  async ingest(ndjson: string): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.base}/ingest`, { method: "POST", body: ndjson, headers: this.headers() });
    return this.readJson(r, "ingest");
  }

  async query(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.base}/query`, { method: "POST", body: JSON.stringify(op), headers: this.headers() });
    return this.readJson(r, "query");
  }

  /** expand(subject, predicate) → node ids */
  async expand(subject: number, predicate: string): Promise<number[]> {
    const j = await this.query({ op: "expand", subject, predicate });
    return (j.nodes as number[]) ?? [];
  }

  /** node detail, optionally authz-scoped: with `allowedLabels` set, a node whose sensitivity label
   *  isn't permitted comes back `{id, denied:true}` (its properties are not leaked). */
  async node(subject: number, allowedLabels?: number): Promise<Record<string, unknown>> {
    const op: Record<string, unknown> = { op: "node", subject };
    if (allowedLabels != null) op.allowed_labels = allowedLabels;
    return this.query(op);
  }

  /** point(subject, predicate) valid-time as-of `at` for a one-cardinality predicate → the node in
   *  effect at that instant, or null (e.g. the membership has ended). */
  async pointAsOf(subject: number, predicate: string, at: number): Promise<number | null> {
    const j = await this.query({ op: "point", subject, predicate, valid_at: at });
    const one = j.one as { node?: number } | null;
    return one?.node ?? null;
  }

  /** edge_props(subject, predicate, object node) → {key: value} (values unwrapped to JS scalars). */
  async edgeProps(subject: number, predicate: string, object: number): Promise<Record<string, number | string | boolean>> {
    const j = await this.query({ op: "edge_props", subject, predicate, object: { node: object } });
    const raw = (j.props as Record<string, Record<string, unknown>>) ?? {};
    const out: Record<string, number | string | boolean> = {};
    for (const [k, wrapped] of Object.entries(raw)) {
      const v = Object.values(wrapped)[0];
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
    }
    return out;
  }
}
