# Vesicle — Architecture

How Vesicle maps sources into StromaDB and operates the result. Companion to `../README.md`.
Technical scope only; business strategy lives in the private platform repo. Design stage.

## Position

```
sources (Postgres, …)
      │  CDC (change data capture)
      ▼
┌──────────────────────────────────────────┐
│ Vesicle                                    │
│  • mapping layer  (source schema → graph)  │
│  • ingest layer   (Zero-ETL CDC → fold)    │
│  • control plane  (managed, multi-tenant)  │
└──────────────────────────────────────────┘
      │  facts (append-only diffs)
      ▼
   StromaDB (OSS engine: storage / query / Live Query)
      ▲
      │  type-aware hybrid queries
   AI agents (caller-side intelligence)
```

## 1. Mapping layer (source → graph)

- Maps source tables/columns to **ontology entity types and relationship predicates** (with
  cardinality and domain/range), producing the declarative half of the ontology StromaDB consumes.
- Authoring modes: **no-code** (AI proposes a catalog + mapping from the schema; the user approves or
  edits), **low-code** (expressions), **programmable** (API).
- Heavy steps (entity resolution, canonicalization) run as **batch/async**, off the hot path.

## 2. Ingest layer (Zero-ETL CDC)

- Captures source changes via CDC and emits append-only diffs to StromaDB's stream fold.
- **Backfill/cutover**: snapshot(LSN) → map → bulk fold → start CDC from that LSN (gap/dup-free).
- Embeddings are produced caller/Vesicle-side (StromaDB receives pre-computed vectors) and
  backfilled in batch; model/dim changes run a new versioned index in parallel.

## 3. Control plane (managed)

- **Multi-tenant** via instance / namespace isolation (StromaDB's tenant namespace is the outer
  boundary); **scale-to-zero** for idle tenants (storage-only cost).
- **Observability** across the agent → DB path, plus deployment and lifecycle.

## Relationship to StromaDB

Vesicle owns *getting data in and operating the service*; StromaDB owns *storing, querying, and
reactively maintaining* the graph. The mapping a Vesicle user authors is exactly StromaDB's
declarative ontology; the facts Vesicle ingests are exactly StromaDB's fold input.
