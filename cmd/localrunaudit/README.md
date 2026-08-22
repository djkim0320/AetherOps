# AetherOps local run audit

Run this command only after closing AetherOps. It opens the production SQLite
database and CAS in read-only mode and fails unless the selected engineering
research run proves the complete fixed stage/model contract, adopted artifacts,
evidence readback, quality gate, 7+1 XFOIL optimization, active memory index,
and materialized knowledge snapshot.

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\localrunaudit `
  -data-root "$env:LOCALAPPDATA\AetherOps\v2" `
  -project-id "<project-id>" `
  -run-id "<run-id>"
```

Success prints one `aetherops_local_run_audit_v1` JSON object with
`"passed": true`. Missing, partial, stale, corrupt, synthetic, or otherwise
unverifiable evidence exits non-zero and prints `"passed": false`.
