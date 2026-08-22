# Live end-to-end release evidence

`livee2eevidence` is the only trusted producer for `live_end_to_end`. It does
not manufacture a result from protocol fixtures. It requires the exact
packaged `ProductBuild`, the ledger revision immediately before attachment, a
completed real `releaseevalrunner` receipt, its passed 12/12 offline evaluation
receipt, and a second protected product observation session created only after
that evaluation receipt's `verified_at` time.

The two sessions are intentionally distinct contracts. Session A runs the
12-case evaluation and contributes the endpoint hash sealed in the runner
receipt. After its offline evaluation is complete, start session B from the
same packaged `ProductBuild` and AetherOps v2 data root. Session B contributes
its own endpoint hash, descriptor hash, and start time; it operates on the same
project and durable SQLite/CAS evidence, but its endpoint is not required to
equal session A's endpoint. A v1 journal, details file, or producer receipt is
retired and rejected.

After the 12/12 evaluation receipt has been written, stop session A and launch
the exact candidate again as session B. Keep this process running while the
live command below executes:

```powershell
C:\release\candidate\aetherops.exe release-eval-session `
  --descriptor "C:\release\evidence\live-e2e-observation-session.json" `
  --data-root "C:\release\evidence\aetherops-evaluation-data"
```

The live phase uses session B to perform a real DevTools MCP `list_pages` and `take_snapshot`,
starts one fixed engineering research run through the authenticated loopback
API, waits for the user to approve any command in the normal UI, executes one
fixed XFOIL polar through the engineering MCP, performs project-scoped SPARQL,
and submits only the evidence-backed `pin_entity` Knowledge editor operation.
It fsyncs a hash-chained record before every POST. A transport-ambiguous write
leaves an incomplete journal which is permanently ineligible and is never
resumed or replayed.

```powershell
go run ./cmd/livee2eevidence -mode live `
  -prepared-ledger C:\release\ledger-current.json `
  -aetherops-exe C:\release\candidate\aetherops.exe `
  -runner-receipt C:\release\runner.json `
  -evaluation-receipt C:\release\quality.details.json `
  -session-descriptor "$env:LOCALAPPDATA\AetherOps\v2\live-e2e-observation-session.json" `
  -journal C:\release\live-e2e.journal.jsonl
```

After the live phase succeeds, close AetherOps. Offline finalization acquires
the product instance lease and opens SQLite/CAS read-only. It verifies every
fixed model/effort/tier stage receipt, the atomic `internal_mcp` evidence
capture marker and CAS bytes, the actual pinned XFOIL execution receipt and all
of its artifacts, the canonical RDF snapshot, the SPARQL generation binding,
and the hash-chained safe curation event before publishing new sibling files.

```powershell
go run ./cmd/livee2eevidence -mode offline-finalize `
  -prepared-ledger C:\release\ledger-current.json `
  -aetherops-exe C:\release\candidate\aetherops.exe `
  -runner-receipt C:\release\runner.json `
  -evaluation-receipt C:\release\quality.details.json `
  -journal C:\release\live-e2e.journal.jsonl `
  -details-out C:\release\live-e2e.details.json `
  -receipt-out C:\release\live-e2e.receipt.json
```

Unit vectors may exercise typed-parser reachability and rejection paths only.
They never run this producer or publish attachable sibling receipts, are not
eligible live evidence, and this command offers no fixture-success switch.
