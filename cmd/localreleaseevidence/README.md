# localreleaseevidence

This release-only command runs one of four fixed local gates and writes a new
candidate-bound evidence receipt with a sibling `*.details.json` file. It does
not edit the append-only ledger and does not claim that the complete release is
eligible.

Producer version 2 seals the complete fixed release-source allowlist before and
after every source-backed gate. The receipt is bound to the exact prepared
ledger revision and records the source-tree SHA-256 and file count; changing a
release source, command plan, candidate file, or predecessor ledger invalidates
the evidence. Gate 0 is candidate-only and deliberately does not claim a source
seal.

```powershell
& .\.tools\go1.26.5\bin\go.exe run .\cmd\localreleaseevidence `
  -gate scheduler_recovery `
  -ledger .\build\release-ledger-r1.json `
  -out .\build\scheduler-recovery.json
```

Allowed gate IDs are `local_source_tests`, `gate0_windows_host`, `rag_50000`,
and `scheduler_recovery`. Commands, test selectors, environments, and timeouts
cannot be supplied by the caller. Candidate files must use the packaged sibling
layout rooted at `build\aetherops.exe`.
