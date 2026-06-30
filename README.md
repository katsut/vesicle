# Vesicle

**Vesicle** is the commercial managed layer on top of [StromaDB](https://github.com/katsut/stromadb):
it turns existing sources into a live, curated knowledge graph and runs it as a managed service.

Where StromaDB is the OSS engine (storage + query + reactivity), Vesicle is the **mapping + ingest +
operations** around it — the part most teams don't want to build or run themselves.

> Status: design stage. Overview/architecture only in this repo; planning lives in the private
> platform repo.

## What Vesicle does

- **Source → graph mapping** — map a source schema (Postgres, …) to ontology types and relationship
  predicates: no-code (AI-proposed → approve/edit), low-code (expressions), or programmable API.
  The mapping author can be anyone: self-serve, a consultant, an embedded SaaS, or a partner.
- **Zero-ETL CDC ingest** — connect a source and changes flow to the graph in real time.
- **Managed, multi-tenant, scale-to-zero** — run many organizations on one platform cheaply; idle
  tenants cost zero compute (storage only).
- **Operability** — agent↔DB observability, deployment, and lifecycle around the StromaDB core.

## Boundaries

- Vesicle **feeds and operates** StromaDB; it is not a general-purpose ETL/data-integration platform
  beyond that purpose.
- Curation, not a data lake: it extracts decision-relevant facts/relations into a bounded graph;
  raw data stays in the source.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how the mapping and ingest layers fit
together.
