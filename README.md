# AetherOps

AetherOps is a Windows 11 research-agent desktop core. It keeps its own code intentionally small while delegating model conversations, ChatGPT authentication, and external MCP connectivity to Codex App Server.

## Tool Studio

A research stage can inspect approved project tools with `tool_catalog`, read an internal Skill with `tool_get`, invoke an adapter through `tool_run`, or propose a reusable capability through `tool_package_propose`. A portable CLI proposal returns an immutable `install_approval`; the stage passes those fields unchanged to the approval-gated `tool_package_install` call. After the user accepts, AetherOps downloads the exact payload, verifies SHA-256 and size through its SSRF-safe network boundary, materializes it under the app-owned project tool root, runs the declared probe, activates it, and resumes the same Codex turn and `stage_attempt_id`. The resulting grant cannot authorize another project, run, or stage.

Two deliberately narrow package kinds are supported:

- **Skill** packages contain a `SKILL.md` plus bounded UTF-8 reference files. Approved skills remain in the project registry and are returned only by project-authorized `tool_get`; they are not copied into a global Codex skill directory.
- **MCP** packages contain a declarative `mcp.json`. Schema v1 supports public HTTPS JSON `GET` adapters with mapped scalar query parameters. Schema v2 additionally supports an official Windows x64 `portable_exe` or `portable_zip` payload through a fixed Go interpreter: argv is a literal/input-token AST, stdin is none or JSON, stdout is bounded JSON/text, and timeout/probe/source/hash/permissions are part of the approval identity. MSI and installer EXEs, npm/pip, scripts, generated adapter code, services, listeners, registry/PATH changes, credentials, and arbitrary file-handle inputs are rejected.

Every managed MCP call still requires an active `(run_id, stage_attempt_id)` and the package's project. A portable install approval grants bounded `tool_run` calls only to that exact live stage; invocations are durably keyed and a crash while native code is running becomes `uncertain` instead of replaying. Job Objects bound process lifetime and descendants, but they are not an AppContainer: an approved native CLI currently runs with the same Windows-user filesystem and network authority. The UI displays that limitation before manual installation. Tool output remains discovery/computation output until an accepted evidence path reads it back.

## Current architecture

- One Go executable owns the local API, research state machine, SQLite database, content-addressed artifacts, scheduler, hybrid RAG and immutable knowledge-generation lifecycle, runtime supervision, tray lifecycle, and WebView2 hosts.
- Preact renders the local shell UI from assets embedded in the executable.
- A dedicated Codex home isolates AetherOps conversations and credentials from the user's normal Codex installation.
- The model popover exposes a session-scoped `default` / `1M` context profile only for GPT-5.6 Sol. The long profile sends `model_context_window=1000000` and `model_auto_compact_token_limit=900000` through stable App Server thread configuration; other models are forced to provider defaults, and the UI reports the actual App Server window when a server-side catalog clamps the request.
- The shell WebView2 and autonomous internet WebView2 use different user-data folders. Only the internet environment exposes a random CDP port to the pinned Chrome DevTools MCP sidecar.
- Each project-visible knowledge head is backed by one verified canonical N-Quads snapshot. A small non-persistent Oxigraph sidecar serves bounded, project-scoped read-only SPARQL from that snapshot; SQLite and CAS remain authoritative.
- Each project's RAG projection has an explicit active/shadow head and monotonic memory revision. A reindex builds complete embeddings off to the side, verifies every vector, then swaps the head atomically; research and reindex startup are transactionally mutually exclusive.
- PLAN can search the run-pinned project memory for adopted reports, evidence, pinned constraints, prior solver settings, and unresolved conflicts. Search hits are candidates only: the planner must read selected chunks back exactly, may use them to shape workstreams and acceptance criteria, and must send current-source or computation claims through COLLECT for fresh verification.
- Every REVIEW attempt starts a fresh `aetherops-reviewer` Codex session with no project-research or previous-review conversation history. It receives only the structured plan, verified evidence bundles, report, engineering identities, and scoring policies; its App Server thread and turn are read-only, offline, and approval-free. The reviewer can perform exact readback but cannot continue research or repair the report itself.
- REVIEW is an executable quality gate, not a report-edit loop. A passing verdict finishes the run. Every new failing verdict must classify the gap as `additional_research` or `replan` and provide concrete remediation tasks. AetherOps preserves the failed cycle as `superseded` audit history, returns the same run to PLAN, performs fresh COLLECT/engineering work, synthesizes a new report, and invokes another fresh isolated REVIEW. Superseded evidence and solver jobs cannot enter the active cycle. At most three autonomous research remediations are allowed before `quality_failed`.
- A passing run atomically adopts both the structured JSON `ReportManifest` and a human-facing DOCX rendered from the embedded AetherOps research-report template. JSON remains authoritative for memory and the knowledge graph; the UI verifies the DOCX CAS hash before offering the Word download. Quality-failed or otherwise non-successful runs never publish an adopted Word report.

## Development

PowerShell 7 or Windows PowerShell 5.1 is sufficient to bootstrap the pinned toolchain:

```powershell
.\tools\dev.ps1 bootstrap
.\tools\dev.ps1 test
.\tools\dev.ps1 run
```

`build`, `run`, and `package` prepare the pinned Windows x64 runtime bundle when it is not already available. The eight-component bundle contains Node.js, Codex App Server, Chrome DevTools MCP, Oxigraph 0.5.9, OpenVSP/VSPAERO, Gmsh, XFOIL, and the OpenMP build of SU2, so a packaged copy can start in normal mode without depending on tools from `PATH`. The first-party read-only knowledge sidecar scripts are copied beside the executable and load only the verified Oxigraph module directory. Official hashes and signatures or npm SRI/signature metadata are checked before `.runtime\active.json` is sealed. A newly generated production package must carry that same verified runtime set, corresponding license texts, and source-acquisition records.

Release packaging is intentionally fail-closed until `AETHEROPS_RUNTIME_FEED_URL`, `AETHEROPS_RUNTIME_KEY_ID`, and `AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64` identify the private signed stable channel. Ordinary local builds remain available without those values and report `build_mode=development`. Before staging or preparing the release ledger, the v2 `runtime-trust-diagnostic` must report `build_mode=release`, configured embedded trust, and exact feed/public-key digests. Runtime trust, data-root, Node, and proxy environment variables cannot change the candidate's embedded identity or adjacent runtime/sidecar trust roots. Packaging also reproduces both checked-in SBOMs, enforces third-party notice/no-first-party-license policy, and emits `SHA256SUMS.txt` only after the exact portable ZIP and installer both exist. Portable smoke now requires the normal-core v2 readiness receipt after verified runtime resolution, Codex initialize plus exact `model/list`, Oxigraph handshake, and API startup; damaging the runtime so only setup could appear must fail without a receipt.

The current developer candidate has been rebuilt and locally authenticated, but no portable ZIP, installer, or package hash has been regenerated with the required private trust inputs. Existing distribution files and their hashes are historical evidence only; [`docs/VERIFICATION.md`](docs/VERIFICATION.md) records the exact boundary.

To prepare or re-verify only the external runtime bundle:

```powershell
.\tools\runtime-bundle.ps1
```

## Release research evaluation

The release path uses a product-hosted loopback session, a source-only runner,
and a separate offline verifier. Prepare the append-only release ledger before
starting any observation:

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\releasegate `
  -mode prepare -aetherops-exe .\build\aetherops.exe `
  -out .\build\release-ledger-r1.json
```

Start the exact executable in release-evaluation mode. It publishes a
current-user-only descriptor and sibling token file; the token is never placed
on argv or in the runner journal and both files are removed when the product
stops:

```powershell
New-Item -ItemType Directory -Path "$PWD\build\release-eval-data"
.\build\aetherops.exe release-eval-session `
  --descriptor "$PWD\build\release-eval-session.json" `
  --data-root "$PWD\build\release-eval-data"
```

In a second terminal, run all 12 versioned prompts against one existing target
project or conversation session. The runner writes `SUBMITTING` durably before
each POST; an ambiguous crash is never retried, while a known started run is
resumed with read-only GET polling. It observes approvals but never approves
them, so requested approval remains a user action in the AetherOps UI.

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\releaseevalrunner `
  -mode start `
  -dataset .\evals\research-v1.json `
  -descriptor .\build\release-eval-session.json `
  -project-id <existing-project-id> `
  -journal .\build\release-eval-runner.journal.json `
  -out .\build\release-eval-runner.json `
  -aetherops-exe .\build\aetherops.exe `
  -runtime-manifest .\build\runtime-manifest.json `
  -knowledge-sidecar .\build\knowledge-sidecar\index.cjs
```

After the runner reaches a terminal result, close AetherOps and verify the
actual SQLite/CAS state through the authenticated Oxigraph sidecar. The details
output name must end in `.details.json`; only `verify-runner` can emit trusted
`live_quality_12` evidence:

```powershell
.\.tools\go1.26.5\bin\go.exe run .\cmd\releaseeval `
  -mode verify-runner `
  -dataset .\evals\research-v1.json `
  -runner-receipt .\build\release-eval-runner.json `
  -prepared-ledger .\build\release-ledger-r1.json `
  -out .\build\release-eval.details.json `
  -evidence-out .\build\evidence-live-quality-12.json `
  -aetherops-exe .\build\aetherops.exe `
  -runtime-manifest .\build\runtime-manifest.json `
  -knowledge-sidecar .\build\knowledge-sidecar\index.cjs
```

Attach that evidence as one new ledger revision with `cmd/releasegate -mode
attach`. Manual execution manifests remain diagnostic-only and cannot produce
trusted live evidence. The verifier checks all 12 real runs, their exact
prompts, fixed stage profiles and Codex receipts, CAS inputs and outputs,
citations, review scores, memory vectors/FTS, graph materialization, generation
lineage, and RDF readback. Protocol fixtures cannot produce a release receipt.
`verify-runner` requires the current `-prepared-ledger`, validates its complete
chain and exact candidate before offline verification, then authenticates it
again before evidence emission. The ledger SHA-256 is included as the
`prepared-ledger` receipt subject, so live evidence cannot be replayed onto a
different ledger for the same binary candidate.

The four fixed local gates are emitted one at a time by
`cmd/localreleaseevidence` (`local_source_tests`, `gate0_windows_host`,
`rag_50000`, and `scheduler_recovery`). `cmd/packagedblackbox` supplies the
fifth local gate by force-terminating and tamper-testing the exact packaged
executable. Every receipt and sibling details file is exclusive-create and must
be attached as its own append-only ledger revision.

`aetherops.exe gate0` emits the typed
`aetherops.gate0.windows.operational.v1` section and exits unsuccessfully when
any required observation is missing. It exercises the live DevTools MCP,
multi-tab WebView2 controllers, Korean IME DOM readback, Per-Monitor v2 DPI,
the native tray callback, same-UDF profile reopen, emergency stop,
manual-to-automatic re-observation, and actual private-network/DNS-rebinding
socket paths. Missing pinned runtimes or Windows input locales are reported as
blockers; they are not replaced with system commands or fixture success data.

The OpenAI Platform API key is optional for compilation and local tests. When supplied later, AetherOps stores it in Windows Credential Manager; it is never read from or written to this repository by the application.

Current pass/fail evidence and release blockers are tracked in [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## Engineering analysis

Engineering solvers are exposed to Codex only through the separate `aetherops-engineering` MCP server during an active research `COLLECT` stage. Its model-visible surface is deliberately typed and bounded:

- `openvsp_wing_aero` creates a trapezoidal wing and runs a VSPAERO angle-of-attack sweep.
- `openvsp_modify_wing` modifies a model artifact produced by the current run.
- `gmsh_wing_mesh` creates and coherence-checks a wing-planform mesh.
- `xfoil_polar` runs a viscous polar for a NACA four-digit airfoil.
- `su2_naca0012` creates a fixed NACA 0012 far-field mesh with Gmsh and runs `SU2_CFD` with bounded OpenMP parallelism.

The model cannot supply executable paths, raw command lines, scripts, or arbitrary filesystem destinations. Every solver call requires an exact user-approved argument hash, runs under a Windows Job Object in a project/run-specific workspace, and publishes verified results plus an execution receipt to the content-addressed store. Interrupted or ambiguous executions are marked uncertain and are never replayed automatically.

## Data

Production data lives under `%LOCALAPPDATA%\AetherOps\v2`; `AETHEROPS_DEV` and `AETHEROPS_DATA_DIR` are ignored by the executable. Developer and release-evidence runs use `release-eval-session --data-root` (or Gate 0's dedicated option) with a canonical, local, non-reparse, non-production directory. Its first use must be empty; AetherOps writes an ownership marker so later evaluation sessions can reopen the same durable data. There is no legacy data import.

The Windows uninstaller removes the program and AetherOps-managed runtime versions and candidates. By default it preserves the SQLite database, CAS objects, Codex home, isolated downloads, and the shell/internet WebView2 profiles under `%LOCALAPPDATA%\AetherOps\v2`. Interactive removal offers separate default-No choices to erase only both WebView2 profiles or all v2 user data, with a second confirmation for the full deletion. Silent removal preserves user data unless `/DELETEBROWSERPROFILES` or `/DELETEUSERDATA` is explicitly supplied to the uninstaller.

## Supported platform

Windows 11 x64 in an interactive user session. Windows services, remote binding, Linux, and macOS are intentionally outside v1.
