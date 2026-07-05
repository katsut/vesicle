# Source plugins

Drop a `<id>.json` file in this directory to register a new source the authoring wizard can pick —
no code change. The server scans this directory on startup and lists what it finds.

Each file:

```json
{
  "label": "Human-readable name shown in the picker",
  "schema": "CREATE TABLE ...;  -- Postgres-style DDL",
  "data":   { "table_name": [ { "id": 1, ... }, ... ], ... }
}
```

- `id` = the file name without `.json`.
- `schema` is the source DDL (the same thing you'd paste into the editor).
- `data` is the sample rows keyed by table name (a JSON object; the server serialises it for the API).

The built-in **HR / projects (sample)** source is always available as the default;
these files are listed alongside it. `GET /api/sources` returns the list; `GET /api/source?id=<id>`
returns one.
