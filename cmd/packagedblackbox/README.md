# Packaged black-box release evidence

`packagedblackbox` is release-only tooling. It tests the exact executable,
runtime manifest, first-party knowledge sidecar, and authenticated eight-part
runtime located below the candidate executable directory. It never opens the
normal `%LOCALAPPDATA%\AetherOps\v2` tree.

Run it only after the final source has been built and the release ledger has
been prepared. Evidence observed before the ledger timestamp is intentionally
inadmissible. For example:

```powershell
& .\.tools\go1.26.5\bin\go.exe run ./cmd/releasegate `
  -mode prepare `
  -aetherops-exe .\build\aetherops.exe `
  -out .\build\release-gate-ledger-r1.json
```

`releasegate` derives `runtime-manifest.json` and
`knowledge-sidecar\index.cjs` from the executable directory; independent path
flags are intentionally unavailable so files from different builds cannot be
combined into one candidate identity.

Then run the black-box campaign:

```powershell
& .\.tools\go1.26.5\bin\go.exe run ./cmd/packagedblackbox `
  -aetherops-exe .\build\aetherops.exe `
  -prepared-ledger .\build\release-gate-ledger-r1.json `
  -out .\build\packaged-blackbox-receipt.json
```

Both the receipt and its sibling `*.details.json` file are created with
exclusive-create semantics. Existing evidence is never overwritten. The
receipt uses the shared `aetherops_release_gate_evidence_v1` contract with
`gate_id` and `evidence_kind` set to `packaged_blackbox`; the details file hash
is sealed into both `details_sha256` and the gate-specific details subject.
`-prepared-ledger` is mandatory. The producer validates the full append-only
ledger chain, requires the exact candidate and an empty `packaged_blackbox`
gate row, and records that ledger's SHA-256 as the `prepared-ledger` subject.
It authenticates the ledger again after the campaign and immediately before
writing evidence; a changed ledger produces no receipt. Consequently a receipt
created for another ledger revision cannot be reused merely because the product
candidate is unchanged.

Attach a passing receipt as one immutable ledger revision. The input ledger,
receipt, details, and output revision must be direct siblings, and the output
must not already exist:

```powershell
& .\.tools\go1.26.5\bin\go.exe run ./cmd/releasegate `
  -mode attach `
  -aetherops-exe .\build\aetherops.exe `
  -ledger .\build\release-gate-ledger-r1.json `
  -evidence .\build\packaged-blackbox-receipt.json `
  -out .\build\release-gate-ledger-r2.json
```

The campaign:

- hashes and authenticates the exact candidate and every active runtime tree;
- force-terminates the real packaged executable in an isolated data root;
- uses an intentionally crashing fixture process only to seed interrupted and
  uncertain work, WAL state, CAS garbage, and an incomplete curation generation;
- starts the real executable to verify fail-closed recovery and repeats startup
  to verify that recovery is idempotent;
- makes a same-volume hardlink mirror of the packaged runtime, detaches only the
  selected tamper target, and proves the real executable rejects the changed
  runtime without modifying the source candidate; and
- changes a copied sidecar and proves the sealed product-build identity rejects
  it before launch.

`-keep-temp` is diagnostic-only and deliberately produces failed gate evidence.
Normal runs validate the exact randomized temporary root before recursively
removing it.

A passed packaged-blackbox receipt satisfies only the local
`packaged_blackbox` gate. Its details explicitly do not claim live service,
clean Windows VM, incompatible hardware, or production signed-feed evidence.
Any later rebuild changes the release candidate ID and requires a new campaign.
