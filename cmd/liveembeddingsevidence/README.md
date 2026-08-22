# Live embeddings shadow evidence

`cmd/liveembeddingsevidence` is an isolated, two-phase producer for the real
`live_embeddings_shadow` release gate. The global release policy and dispatch
do not trust it yet; that final wiring is intentionally reserved for root
coordination after review.

The live phase requires the exact packaged candidate, current empty prepared
ledger, versioned 12-case dataset, completed live `releaseevalrunner` receipt,
and that runner's still-active protected session descriptor. The receipt must
target an existing populated project. The command reads the token only through
the descriptor's protected sibling file and never writes the token or raw query
to output.

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\liveembeddingsevidence `
  -mode live `
  -prepared-ledger .\build\release-ledger-r8.json `
  -aetherops-exe .\build\aetherops.exe `
  -dataset .\evals\research-v1.json `
  -runner-receipt .\build\release-eval-runner.json `
  -session-descriptor "$env:LOCALAPPDATA\AetherOps\v2\release-eval-session.json" `
  -query "the exact bilingual evidence query" `
  -journal .\build\live-embeddings-shadow.journal.jsonl
```

Before each state-changing POST the append-only hash-chained JSONL journal is
flushed with `Sync`. A transport error or invalid success response is recorded
as ambiguous. Existing journals are never resumed, so neither the real reindex
POST nor the real embedding-backed search POST can be retried automatically.
The required successful path is:

`PREPARED → REINDEX_SUBMITTING → REINDEX_OBSERVED → SEARCH_SUBMITTING → LIVE_COMPLETE`.

After the live phase, stop AetherOps and finalize against immutable storage:

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\liveembeddingsevidence `
  -mode offline-finalize `
  -prepared-ledger .\build\release-ledger-r8.json `
  -aetherops-exe .\build\aetherops.exe `
  -dataset .\evals\research-v1.json `
  -runner-receipt .\build\release-eval-runner.json `
  -journal .\build\live-embeddings-shadow.journal.jsonl `
  -details-out .\build\live-embeddings-shadow.details.json `
  -receipt-out .\build\live-embeddings-shadow.receipt.json
```

The finalizer acquires the real single-instance lease, opens SQLite and CAS
read-only, reauthenticates the candidate/ledger/runner receipt, verifies every
CAS source and deterministic chunk, validates every 1536-float32 finite vector
and its SHA-256, proves the old active index was retired and the observed
shadow became the sole active revision, and reads back every live search chunk.

There is no mock or fallback success path. Protocol fixtures may exercise
rejection and ambiguity/no-retry mechanics only and cannot emit a passing
release receipt.
