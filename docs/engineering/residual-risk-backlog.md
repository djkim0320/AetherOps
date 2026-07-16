# AetherOps Residual-Risk Backlog

Updated: 2026-07-16 (Asia/Seoul)

This backlog starts after the implemented Phase 1 promotion-integrity and Phase 2 artifact-durability
slices. It records work that is intentionally not represented by placeholder tables, unused
interfaces, synthetic success, or a production feature flag. The live `.aetherops` data root remains
read-only until the owner explicitly authorizes a verified cutover.

## P1 — Job-scoped provisional research generation

- **title:** Prevent engineering observations from entering primary research state before durable
  promotion succeeds.
- **severity:** Critical; a late baseline, CAS, lease, canonical-terminal, or event failure can reject
  the durable promotion after the legacy orchestrator has already written report, final output,
  searchable records, graph data, project files, and global memory.
- **evidence:** `ExecutionOrchestrator.persistToolResults()` writes tool artifacts, evidence, sources,
  and runs immediately after ToolRunner returns. `LoopControlOrchestrator.startLoop()` then performs
  normalization, indexing, ontology, reasoning, synthesis, and finalization. Only after it returns does
  `registerDurableResearchLoopHandler` build promotion drafts and call the atomic terminal transition.
  Source derivation also drops some attempt lineage, so a later cleanup cannot prove completeness.
- **violated invariant:** Unpromoted, failed, interrupted, stale, or quarantined engineering outputs
  must not be visible to evidence, memory, search, ontology, reports, or final output.
- **proposed design:** Introduce a durable job-scoped provisional generation and project-storage
  overlay. Keep ToolRunner output, normalized records, graph, validation, result, report, memory, and
  final output in that generation. Preserve `originJobId`, `originAttemptId`, `originOutputLinkId`, and
  `generationId` on every derivative. Split workspace prepare from commit/quarantine. The fenced
  terminal transaction must commit promotion receipts, generation visibility, checkpoint/job state,
  and events together; primary readers must select only committed, current, non-stale generations.
- **acceptance criteria:** Any failure after ExecuteTools leaves zero rows or files visible through
  primary snapshot, global search, report, memory, or final-output reads; all attempts and generation
  objects are terminal and quarantined. Successful terminal commit makes the complete generation
  visible exactly once and restart readback produces the same hashes.
- **required tests:** Fault injection after ExecuteTools, normalization, finalization, promotion, and
  terminal-event append; process kill at every staging boundary; exact retry; pause/abort/lease loss;
  baseline activation before terminal commit; cross-project/global search isolation; lineage
  completeness; stale-result omission from reports and memory.
- **migration impact:** Requires one checksum-bound additive migration only after the generation
  repository, visibility transaction, readers, recovery, and rollback path exist. Legacy tables remain
  readable and are converted to a committed legacy generation during migration.
- **compatibility risk:** This changes when intermediate results become visible and requires a single
  cutover of legacy readers/writers. Dual-write would reintroduce ambiguity and is not allowed.
- **dependencies:** Project FIFO and lease fencing, existing terminal CAS/promotions, operation journal,
  canonical checkpoint lineage, the v13 project revision ledger, and bounded cleanup.
- **owner decision needed:** Approve the single-cutover visibility model and whether a failed job's
  individually valid engineering action may ever be promoted independently; the conservative default
  is whole-generation quarantine.

## Phase 3 — Live migration cutover and recovery receipt

- **title:** Cut over the real `.aetherops` root to operational schema v14.
- **severity:** High; the product cannot use the new baseline and promotion records against the live
  data root until cutover succeeds.
- **evidence:** Read-only `migrate:check` reports an unapplied live target. Temporary-root migration
  tests cover populated v2, v4, v8, and v11 targets through v14, checksum conflict, recovery,
  zero-change reapply, verification, rollback, project revisions, and cross-database mutation receipts.
  No live apply has been authorized or attempted.
- **violated invariant:** A production write path may start only after backup, integrity, semantic
  readback, migration checksum, and authoritative-target verification have succeeded.
- **proposed design:** Use the existing migration coordinator and the v12-v14 checksum chain. Produce a pre-cutover
  source manifest, acquire migration and storage-owner locks, checkpoint WAL files, create the backup,
  apply in staging, verify SQLite/FK/ID/hash/CAS and semantic readback, atomically replace the target,
  restart the worker, and record a bounded cutover receipt. Preserve the rollback archive and never
  dual-write.
- **acceptance criteria:** One authoritative v14 target; `integrity_check=ok`; foreign-key check empty;
  source IDs and canonical hashes unchanged; v12-v14 checksums exact; second apply changes zero bytes;
  restart readback succeeds; rollback rehearsal restores the pre-cutover target.
- **required tests:** Clone-of-live dry run in an owner-approved temporary root; process crash before
  and after atomic replace; concurrent server startup denial; CAS manifest readback; restart after
  commit; rollback after restart; settings and secret-hash invariance.
- **migration impact:** Applies existing operational migrations 12 through 14 and updates the migration pointer and
  manifests. It must not delete legacy tables or archives.
- **compatibility risk:** Forward-only v14 writes require explicit approval before restoring a pre-v14
  backup because post-cutover data could be lost.
- **dependencies:** Owner-approved maintenance window, sufficient free space, verified backup target,
  and no active storage-worker owner.
- **owner decision needed:** Explicit authorization to clone and then mutate the real `.aetherops`
  root, plus approval of the rollback data-loss boundary.

## Phase 4 — Provider and native-tool readiness receipts

- **title:** Unify Codex, Search, and native engineering readiness with router hard filtering.
- **severity:** High; the current live doctor reports an unsupported reasoning effort and Search/native
  commands are unavailable, so live execution readiness is not established.
- **evidence:** The runtime model catalog and provider call path are strict, while doctor and legacy
  settings inspection still use a separate normalization path. Existing diagnostics expose blocked
  states but do not share one versioned readiness receipt with the router.
- **violated invariant:** A tool may be exposed to the planner or executed only when requested and
  effective capability, platform, binary identity, license, sandbox, and current readiness all pass.
- **proposed design:** Extend the existing diagnostics boundary with a bounded, provider-neutral
  readiness receipt. Reuse the canonical Codex settings schema for requested/effective model and
  effort. Record binary version/hash, platform, license and sandbox disposition for native tools.
  Cache only with explicit TTL and invalidation; make the catalog/router consume the receipt as a hard
  filter.
- **acceptance criteria:** Unsupported effort has no silent fallback; requested/effective configuration
  is traceable; unavailable Search/native tools are never proposed or executed; local offline
  engineering remains usable; entitlement remains `not_checked` until actually verified.
- **required tests:** Unsupported/legacy effort, OAuth absent, entitlement unavailable, Search disabled
  or unconfigured, binary missing/hash mismatch/version mismatch, unsupported platform, missing
  license, sandbox unavailable, TTL expiry, invalidation, and router exclusion.
- **migration impact:** None until a concrete durable readiness-history requirement is approved. Do not
  add a snapshot table merely for diagnostics.
- **compatibility risk:** Stricter hard filtering can turn previously attempted tools into explicit
  `blocked` outcomes; RPC/SSE error codes and existing offline flows must remain compatible.
- **dependencies:** Canonical settings normalizer, existing capability resolver, diagnostics, tool
  catalog, and native process adapters.
- **owner decision needed:** Decide whether readiness history must survive restart or whether bounded
  runtime receipts and job traces are sufficient.

Implementation note (2026-07-16): the active execution boundary now fail-closes native XFOIL, SU2,
OpenVSP, XFLR5, mesh/modeling, and all-target probes before process or filesystem side effects because
their exact promotion runtime receipts are not yet supported. WebXFOIL `0.1.1` and Codex CLI
`0.144.1` proceed only when the frozen active baseline declares the identical pinned version. This
closes the false-ready execution path, but it does not complete the broader Search/provider receipt,
license, sandbox, TTL, or live entitlement work described above.

The execution registry and its legacy server-runtime preflight both enforce this boundary before any
native probe, command, or modeling-root inspection. `all`, native, and modeling preflight requests are
therefore explicit `NOT_READY` outcomes; only the pinned WebXFOIL receipt can complete that preflight.
Native template validation remains covered as a separate pure/direct-adapter contract rather than
being inferred from an unreachable process execution.

Before native XFOIL can be enabled, its polar draft must bind the measured airfoil input receipt to
`airfoilGeometryHash`. The currently unreachable native branch still supplies the general
`geometryHash`, while the shared polar policy correctly requires the airfoil-specific hash. The
fail-closed readiness gate prevents execution today; enabling that adapter without fixing and testing
this mapping is prohibited.

WebXFOIL implementation note (2026-07-16): the bundled adapter now hashes the canonical post-`PANE`
coordinates emitted by the same run as the polar and creates a separate receipt over the full polar
rows, request, convergence classification, geometry receipt, and runtime version. Terminal promotion
recomputes that receipt from exactly one paired full artifact before CAS materialization. Artifact and
evidence promotions share the same polar dependency set and become stale together when the active
airfoil geometry or aerodynamic reference changes. This is same-runtime reproducibility evidence; it
does not substitute for the Windows/Linux and independent-oracle policy required by Phase 5.

CAS implementation note (2026-07-16): pending claims are owner-scoped to project, job, durable
attempt, output kind, and output ID. Hash locks, versioned journals, exact terminal read-retry, and
restart reconciliation cover response loss and post-commit cleanup. Reference iteration and each
mutation are bounded, but reconciliation currently performs a full `O(total CAS objects)` scan with no
durable cursor; large-store incremental reconciliation remains a scale optimization for a later
storage milestone.

## Phase 5 — Cross-platform aerodynamic reproducibility policy

- **title:** Establish evidence-derived Windows/Linux and WASM/native aerodynamic tolerances.
- **severity:** High for engineering claims; exact fixture hashes alone do not justify cross-platform
  numerical equivalence.
- **evidence:** Deterministic Clark-Y/WebXFOIL fixtures and convergence checks exist, but there is no
  versioned field-specific tolerance policy supported by independent platform runs.
- **violated invariant:** A promoted engineering result must state the solver/media identity and may be
  declared equivalent only under a reviewed, evidence-backed policy; non-converged or failed cases
  cannot pass through numeric tolerance.
- **proposed design:** Measure repeated runs by pinned solver, adapter, OS, architecture, and Node
  version. Derive separate absolute/relative limits for CL, CD, CM and alpha, while requiring exact
  convergence, failed-case, warning, reference-geometry and finiteness classifications. Use an
  independently sourced fixture and version each approved policy with benchmark receipt hashes.
- **acceptance criteria:** Finite and physically sane outputs; exact classification sets; held-out cases
  satisfy field-specific tolerances on supported Windows and Linux runners; any tolerance change has a
  before/after benchmark and review status; non-converged promotion remains zero.
- **required tests:** Multiple runs per platform, symmetric-airfoil zero-alpha behavior, lift-slope
  sanity, drag sign, CM convention, normal/partial/non-converged/domain-boundary cases, independent
  oracle comparison, NaN/Inf rejection, and policy-boundary mutation tests.
- **migration impact:** No schema until the policy is consumed by production promotion or report
  verification. If persistence becomes necessary, add one checksum-bound migration with its active
  repository and readback path.
- **compatibility risk:** Tight evidence-derived limits can expose previously hidden platform drift;
  loosening a limit without new evidence is prohibited.
- **dependencies:** Supported Windows/Linux CI runners, pinned WebXFOIL/native toolchain identities,
  license availability, and independent reference data with source/license/hash metadata.
- **owner decision needed:** Approve supported platform/CPU matrix and the independent reference
  dataset/license.

## Phase 6 — Held-out tool-catalog evaluation and shadow routing

- **title:** Add independently maintained held-out and adversarial evaluation for bounded tool routing.
- **severity:** Medium-high; unit tests beside the implementation do not demonstrate generalization at
  100- or 1,000-tool scale.
- **evidence:** Current catalog routing applies capability, frame, discipline, fidelity, license, risk,
  and readiness filtering with deterministic ordering, but lacks a versioned held-out corpus and a
  promotion threshold.
- **violated invariant:** Ranking must not reference fixture IDs or expected tool IDs, and shadow
  evaluation must never execute a second side effect.
- **proposed design:** Separate seed, held-out, adversarial and regression fixtures with immutable
  source/license/hash metadata. Generate deterministic 10/100/1,000-descriptor catalogs, hard-filter
  before ranking, measure top-k and final choice, and run vNext selection in read-only shadow mode
  alongside the current router.
- **acceptance criteria:** At 1,000 tools, top-5 recall at least 95%; unauthorized, outside-domain and
  unavailable executions zero; ordinary turns expose only a bounded 3–8 full schemas; stable metrics
  and report hashes across worker counts; shadow side-effect count zero.
- **required tests:** Similar-name decoys, capability/fidelity/domain/unit/frame/baseline mismatch,
  unsupported platform, unavailable licensed solver, malicious descriptions, project-policy denial,
  readiness changes immediately before execution, deterministic ranking, schema-byte budget, latency,
  and estimated-cost accounting.
- **migration impact:** None during offline evaluation. Persisted evaluation runs require a later
  checksum-bound migration only when a production consumer and retention policy exist.
- **compatibility risk:** Changing the default router before held-out gates pass could alter tool choice;
  vNext remains non-executing shadow output until explicitly promoted.
- **dependencies:** Versioned catalog snapshot, readiness hard filter from Phase 4, fixture governance,
  and deterministic evaluator/report generator.
- **owner decision needed:** Approve the held-out fixture owner, promotion thresholds, and whether
  catalog results are CI artifacts or durable product records.

## Release evidence — Git/report integrity and CI coupling

- **title:** Bind verification reports to the exact source tree and executed receipts.
- **severity:** Medium-high; an older report can appear current after HEAD or working-tree changes.
- **evidence:** The residual-risk plan records `a85cbaf`, branch and dirty-state assumptions manually;
  no generator currently rejects stale body metadata or missing test receipts.
- **violated invariant:** A verification report may claim only commands that ran, and must identify the
  exact commit, diff/dirty state, migration version, catalog version and receipt hashes that produced
  it.
- **proposed design:** Add a deterministic report-metadata generator and verifier using bounded Git
  porcelain output, tree/diff hashes, command/exit/duration/environment receipts and schema/catalog
  versions. Treat any post-generation source change as stale. Add only deterministic offline gates to
  required CI; keep credentialed/live jobs separate.
- **acceptance criteria:** Clean, staged, unstaged and untracked states are distinguished; report body
  and metadata mismatch fails; unexecuted tests cannot appear as passed; CI verifies migrations v12-v14,
  promotion/readback, aerospace and report receipts without secrets.
- **required tests:** HEAD change after generation, file mutation, staged-only and untracked-only state,
  hard-coded SHA mismatch, absent/failed command receipt, environment hash change, migration/catalog
  version mismatch and secret-redaction canaries.
- **migration impact:** None unless report metadata becomes product data; CI artifacts are preferred.
- **compatibility risk:** Existing hand-written reports become historical/non-authoritative rather than
  silently accepted as current.
- **dependencies:** Completion of Phases 3–6 evidence producers and CI artifact-retention policy.
- **owner decision needed:** Approve authoritative report format, retention period, and whether dirty
  local reports are publishable or diagnostic-only.
