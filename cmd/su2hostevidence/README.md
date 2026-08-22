# Incompatible SU2 host release evidence

`su2hostevidence` is the only trusted producer for the external
`incompatible_su2_host` release gate. Run it on a real Windows 11 x64 machine
whose native CPUID/XGETBV observation is missing at least one required SU2
win64-omp capability: AVX, AVX2, FMA, BMI1, BMI2, XSAVE, OSXSAVE, or enabled
XMM/YMM state. CPUID's hypervisor-present bit must be clear; virtualized feature
masking is not accepted as an incompatible hardware observation.

```powershell
& .\.tools\go1.26.5\bin\go.exe run .\cmd\su2hostevidence `
  -ledger .\build\release-gate-ledger-r1.json `
  -out .\build\incompatible-su2-host.receipt.json `
  -aetherops-exe .\build\aetherops.exe `
  -runtime-manifest .\build\runtime-manifest.json `
  -knowledge-sidecar .\build\knowledge-sidecar\index.cjs
```

The producer first observes the physical host directly, then runs exactly
`aetherops.exe su2-host-preflight` without a shell and under a Windows Job
Object. A passing receipt requires both observations to match, the candidate
to return a typed `rejected` decision, and `su2_execution_attempted=false`.
The complete ledger chain, immediate predecessor revision, exact product
candidate, command stdout/stderr, CPUID registers, and XCR0 are hash-bound.

On compatible hardware the command returns a pending error before reading
candidate paths or creating output files. Do not disable CPU features through
environment settings, virtualized fixtures, or test hooks: such results are
not admissible release evidence. The gate must remain pending until the same
candidate is run on genuinely incompatible Windows x64 hardware.
