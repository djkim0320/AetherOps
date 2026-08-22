# AetherOps knowledge sidecar

This directory contains the pinned Oxigraph `0.5.9` Node/WASM process used for
read-only SPARQL evaluation. It has no filesystem or network input contract:
the only RDF bytes it can use arrive as a verified N-Quads snapshot on stdin.

## JSONL protocol

Each stdin line is one JSON object and produces exactly one stdout line:

```json
{"id":"1","method":"load","project_id":"prj_1","generation_id":"gen_1","snapshot_nquads":"<urn:s> <urn:p> <urn:o> .\n","snapshot_sha256":"...","triple_count":1}
{"id":"2","method":"query","project_id":"prj_1","generation_id":"gen_1","query":"SELECT * WHERE { ?s ?p ?o }","max_rows":500,"max_bytes":1048576,"timeout_ms":5000}
```

Responses always have `{id, ok, result, error}`. A load is committed only
after its UTF-8 SHA-256, N-Quads parse, and unique quad count all match. An
empty string with the SHA-256 of empty input and `triple_count: 0` is a valid
empty generation for a new project. The
process keeps a bounded LRU of project/generation workers. Each worker owns one
in-memory Oxigraph Store; replacing a generation is atomic.

Only `SELECT`, `ASK`, `CONSTRUCT`, and `DESCRIBE` are accepted. SPARQL Update
keywords and `SERVICE` are rejected both before dispatch and inside the worker.
Row or byte overflow returns an error with `result: null`; truncated or partial
answers are never emitted. A timed-out worker is terminated and its cached
generation is discarded.

Install and verify with:

```powershell
npm install
npm test
```
