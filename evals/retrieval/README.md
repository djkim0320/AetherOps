# `hybrid_graph_v1` 50,000-chunk release gate

This opt-in gate builds a real temporary SQLite database with WAL,
`synchronous=FULL`, foreign keys, FTS5, and 50,000 persisted 1536-dimensional
little-endian float32 embeddings. The deterministic corpus contains mixed
Korean and English text. It also materializes and activates a non-empty graph
generation with eight seed entities, 32 expandable one-hop assertions, 24 graph
evidence candidates, and complete open-dispute pairs.

Run from the repository root with the pinned Go toolchain:

```powershell
$env:AETHEROPS_RUN_50K_RETRIEVAL_GATE='1'
& .\.tools\go1.26.5\bin\go.exe test .\internal\store -run '^TestHybridGraphV1FiftyThousandChunkReleaseGate$' -count=1 -v
```

The test calls the production `SearchMemory` and `SearchMemoryWithGraph`
methods. It does not replace SQLite, FTS5, embedding decoding/checksums,
`rag.ExactTopK`, or weighted RRF with mocks. Exact vector search therefore uses
the production `runtime.NumCPU()` worker pool and reads all 50,000 float32 BLOBs
for every measured query.

The release gate requires all of the following:

- FTS5 top 50 and exact-vector top 50 are both exercised.
- Weighted RRF (`lexical=1.0`, `vector=1.0`, `graph=0.5`) returns exactly 12.
- Graph expansion uses at most eight seeds and exactly exercises the 32
  assertion limit while keeping every included dispute pair whole.
- Graph-only results are at most four and each source artifact contributes at
  most two final results.
- Warm graph expansion p95 is at most 75 ms.
- `hybrid_graph_v1` total p95 is no more than 25% above `hybrid_v1` total p95.

Three paired queries warm the database and worker path. The gate then records
20 alternating-order baseline/graph pairs and 30 graph-expansion samples. A
machine-readable, versioned receipt is atomically written to
`evals/results/hybrid-graph-v1-50k-performance-v1.json`. Set
`AETHEROPS_RETRIEVAL_RECEIPT` only when an isolated output location is needed;
the thresholds and test path remain unchanged.

Normal `go test ./...` runs compile this harness but skip its large dataset.
Release verification must run the opt-in command and requires `passed: true` in
the generated receipt.
