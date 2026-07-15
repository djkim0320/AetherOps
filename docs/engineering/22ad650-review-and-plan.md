# 22ad650 Engineering Reliability Review and Plan

Reviewed baseline: `22ad650771557ace7a91c7cc41c21a8f83c81387` on 2026-07-15. The review was performed against the current source tree; earlier findings were not assumed to remain true. The existing untracked user directories and the live `.aetherops` data root were not modified.

Status vocabulary is limited to `verified`, `partial`, `absent`, `disproved`, and `deferred`.

## Baseline

- `HEAD == 22ad650`; no later commit or divergent history is involved.
- Tracked worktree and index were clean at review start. Existing untracked `docs/literature-review-2026-06-27/`, `output/`, and `tmp/` were preserved.
- `npm ci` passed with 430 packages and zero reported vulnerabilities.
- Format, lint, architecture, size, style, CSS-token, typecheck, full test, and build gates passed before implementation.
- Full baseline tests: 175 files and 967 tests passed in 110.52 seconds.
- Live data `migrate:check` reported `needs-apply`; `migrate:verify` therefore failed with `not-applied`. No migration was applied to live data.
- Offline doctor passed; live readiness was false because Codex reasoning access, search readiness, and engineering commands were unavailable.

## Capability matrix

| Capability | Status | Evidence | Reproduction | Existing control | Required change | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| Boot-unique worker identity | verified | `durableRuntimeConfig.ts:46-59` | Runtime config tests | PID plus boot `randomUUID()` | None | Retain same-PID/two-runtime assertion |
| Attempt and lease-generation fence | verified | `jobRepository.ts:157-203,267-278`; `jobSchema.ts:48-74` | `jobReliability.test.ts` | Attempt, owner, generation, expiry in SQL predicate | None | Retain stale completion/failure tests |
| Storage Worker stale-write rejection | verified | `typedRuntime.ts:47-54`; `fencedWriteScope.ts:5-71` | Late writer after successor claim is rejected | Fenced transaction and `LeaseLostError` | Extend the same boundary to all product artifact writes | Stale event/checkpoint/trace/promotion matrix |
| Product-wide stale-write rejection | verified | `durableEngineeringJobHandler.ts`; `durableCanonicalTerminalTransition.ts`; `fencedWriteDispatch.ts` | Actual HTTP -> queue -> Storage Worker -> ToolRunner -> bundled WebXFOIL integration and stale-fence tests | Direct engineering uses the durable staged execution and fenced promotion path | None for the active engineering path | Barrier, cancellation, and real WebXFOIL integration tests |
| Non-overlapping lease renewal | verified | `durableLeaseRenewal.ts:14-57` | Slow renewal test | Recursive single `setTimeout` loop | None | Retain slow-renewal test |
| Renewal rejection handling | verified | `durableJobExecutor.ts:53-85,211-231` | Storage failure test | Abort controller plus lease-loss diagnostics | None | Retain sync/async rejection tests |
| Renewal stop before forced storage close | verified | `durableLeaseRenewal.ts`; `durableJobExecutor.ts`; `durableJobRuntime.test.ts` | Close/renewal/storage race is covered with an abort-ignoring handler | Renewal handles are tracked and stopped before forced storage close | None | Retain shutdown race regression |
| One active handler per project | verified | `jobSchema.ts:55-57`; `jobRepository.ts:118-131,157-181` | FIFO and active-lane tests | Partial unique index, SQL guard, local scheduler | None | Retain cross-runtime lane test |
| Atomic claim, running attempt, event | verified | `jobAtomicOperations.ts:26-42`; `typedRuntime.ts:59-60` | Event-ID conflict rolls back claim | One Storage Worker transaction | None | Publish-after-commit crash replay |
| Atomic completed terminal transition | verified | `jobAtomicOperations.ts:45-110,182-264`; `runStateAtomicOperations.ts:49-90` | Atomicity and retry tests | Checkpoint, attempt, event, promotion, terminal in one transaction | None | Retain subscriber-failure replay test |
| Atomic failed/paused/aborted transition | verified | `durableCanonicalTerminalTransition.ts`; `jobAtomicOperations.ts`; `jobToolAttemptSettlement.ts` | Fault-injection and job atomicity tests cover terminal attempt disposition, job state, and events | One fenced Storage Worker transaction settles active attempts and appends terminal events | None | Retain crash, subscriber failure, and retry matrix |
| Runnable-project recovery beyond 1,000 | verified | `durableJobRecovery.ts:5-14`; `jobRepository.ts:118-131` | Existing 1,001-project test | Keyset project cursor | None | Add 1,001 jobs in one project FIFO restart case |
| Queue position without list scan | verified | `jobRepository.ts:133-148` | Queue-position tests | SQL `COUNT` over queued-at/id order | None | Same timestamp 300-job case |
| Job list status filter before limit | verified | `jobRepository.ts:95-115` | Pagination tests | SQL `WHERE` precedes `LIMIT` | Bind cursor to filter/snapshot if stable paging is required | Cross-filter cursor rejection |
| Idempotency request-hash conflict | verified | `jobRepository.ts:39-86`; unique index in `schema.ts` | Completed retry and changed-payload tests | Project/key unique index and request hash | None | Retain exact-status receipt test |
| Durable side-effect exactly-once | verified | `toolSideEffectReservationSchema.ts`; `toolSideEffectReservationRepository.ts`; `durableToolAttemptIdentity.ts` | Real Worker/SQLite/ToolRunner response-loss integration executes the external body once and blocks the retry as ambiguous | Project-scoped durable reservation, verified postcondition, and conservative ambiguity state | Live provider evidence remains separate from the offline runtime proof | Response loss, lease expiry, takeover, backfill, checksum, and idempotency tests |
| Trace keyset pagination and byte budget | verified | `tracePagination.ts:34-107`; `jobTraceBudget.ts` | 1,000-attempt and response-budget tests | Opaque cursor, SQL ordering, serialized budget | Batch terminal retry/promotion reads | Query-count assertion for 200 promotions |
| JSON response byte limit | verified | `boundedHttpBody.ts:24-89`; `boundedHttpClient.ts:73-145` | Exact/max+1/chunked/forged-length tests | Shared bounded byte reader and body cancellation | None | Retain raw-byte equality assertion |
| Strict JSON UTF-8 and error redaction | verified | `boundedHttpBody.ts:70-89` | Invalid UTF-8/JSON/empty tests | Fatal decoder and bounded diagnostics | None | Retain no-body-leak assertion |
| Caller abort during initial fetch | verified | `boundedHttpClient.ts`; `boundedHttpClient.test.ts` | Pending policy and transport abort immediately with stable failure classification | One combined caller/deadline signal covers policy and transport | None | Retain pending resolver and pending transport tests |
| Deadline during DNS/URL policy | verified | `boundedHttpClient.ts`; `publicUrlPolicy.ts`; `boundedHttpClient.test.ts` | Stalled resolver and URL-policy work are bounded by the request deadline | One deadline and abort boundary covers every hop | None | Retain stalled-policy deadline test |
| Redirect status restriction | verified | `boundedHttpClient.ts:9-19,171-205` | 300/304/305/306 remain terminal | Only 301/302/303/307/308 followed | None | Retain method matrix |
| Cross-origin credential stripping | verified | `boundedHttpClient.ts:246-288` | Same/cross/multi-hop/origin-return tests | Sensitive headers are removed and not reconstructed | None | Retain mixed-case headers |
| Redirect destination URL policy | verified | `boundedHttpClient.ts:171-205` | Private redirect tests | Policy applied per hop | Add connect-time peer enforcement for DNS rebinding | Public-at-check/private-at-connect test |
| DNS rebinding/TOCTOU protection | verified | `pinnedHttpTransport.ts`; `verifiedBrowserProxy.ts`; `publicUrlPolicy.ts` | Controlled rebind tests verify the connect-time peer against the validated address set for HTTP and browser traffic | Pinned Undici lookup and browser loopback verification proxy revalidate every connection | Platform-specific browser proxy behavior remains covered by Chromium integration on the current Windows runtime | Rebind, private IPv4/IPv6, redirect, and actual Chromium integration tests |
| Browser RSS bounded/public fetch | verified | `browserRssDiscovery.ts`; `boundedHttpClient.ts`; `backgroundBrowserRuntime.ts` | RSS acquisition uses the shared bounded/policy-checked client | Byte, redirect, abort, timeout, and URL-policy limits are shared with WebFetch | None | Oversize, redirect-private, abort, and timeout tests |
| HTTP ingress Content-Type and length | verified | `webServer.ts:336-348`; `jsonBody.ts:41-127` | Web-server body-limit tests | Media-type, encoding, declared and actual byte checks | None | Retain request abort/timeout matrix |
| Generic 500 redaction | verified | `webServer.ts:190-220`; `errorBoundary.ts` | Error-boundary tests | Public constant plus internal diagnostic ID | None | Retain secret/redaction test |
| Shutdown HTTP admission barrier | verified | `serverDrain.ts:25-52`; `webServer.ts:141-145` | Drain tests | New requests get 503/Retry-After | Extend admission barrier to durable enqueue/claim at shutdown start | Accepted-RPC/enqueue race |
| Durable admission closes at shutdown start | verified | `durableRuntimeAdmission.ts`; `durableJobRuntime.ts`; `webServer.ts` | Admission race test proves enqueue/claim cannot cross the synchronous drain barrier | `beginDrain()` closes durable admission before HTTP grace waiting | None | Retain accepted-RPC/enqueue race test |
| Active engineering cancellation | verified | `durableEngineeringJobHandler.ts`; `src/server/runtime/process/`; engineering adapters | Actual child-process cancellation and durable ToolRunner tests verify bounded process-tree termination and quarantine | One AbortSignal reaches tool, solver, process, and terminal settlement | Native third-party binaries remain prerequisite-gated | Retain real child barrier and WebXFOIL cancellation tests |
| Browser shutdown ownership | verified | `backgroundBrowserRuntime.ts`; `backgroundBrowserRuntime.integration.test.ts`; `webServer.ts` | Close during pending navigation disposes tracked contexts within the shutdown budget | Active-context registry with idempotent bounded disposal | None | Retain actual Chromium close-during-navigation test |
| SSE connection/event/byte budgets | verified | `sseDelivery.ts:12-159`; `sseReplay.ts:41-205` | 98 focused HTTP/SSE tests passed | Serialized writer, caps, replay/live merge | None | Retain duplicate/gap/reconnect tests |
| SSE replay duration during stalled drain | verified | `sseReplay.ts`; `sseDelivery.ts`; `sseController.test.ts` | Never-resolving drain is raced against connection abort and the remaining replay deadline | Bounded serialized writer and replay deadline close the stream | None | `write=false`, no drain, replay timeout, and disconnect tests |
| Configuration baseline domain | partial | `configurationBaseline.ts`; `engineeringRunState.ts` | Pure-domain invalidation tests | Geometry/source/solver/unit/frame change analysis | Persist baseline and dependency invalidation under worker authority | Stale result rejected by report/memory |
| Quantity and dimension domain | verified | `quantity.ts`; `units.ts` | Unit adversarial tests | SI canonical values and provenance | Extend public engineering API coverage | lbm/lbf, psig/psia, temperature delta |
| Coordinate frame validation | verified | `frames.ts`; `frames.test.ts` | Same-handed reflection and cross-handed identity are rejected; a cross-handed reflection is accepted with determinant -1 | Orthonormality, round-trip, and determinant sign must agree with source/target handedness | None for the current DCM transform contract | Same-handed and cross-handed adversarial transforms |
| Coefficient reference geometry | partial | `aerodynamicValidation.ts`; engineering metadata | Validation slice records coefficient convention | General engineering outputs do not all carry typed reference definitions | Add typed reference geometry to promotion gate | Area/chord/reference-point mismatch |
| ModelCard use assessment | verified | `modelCard.ts`; `modelAndSimulation.test.ts` | Draft/rejected cards cannot be accepted; documented defects produce `accepted_with_limits` and a placard | Use, review status, verification/validation domain, evidence, and known defects are assessed fail-closed | Defect applicability is currently card-wide rather than variable-specific | Rejected-card and known-defect adversarial tests |
| SimulationRunReceipt validation | verified | `analysisEvidence.ts`; `modelAndSimulation.test.ts` | NaN convergence, non-positive tolerance, malformed optional hashes, completed runs with error diagnostics, duplicate output IDs, and invalid postconditions are rejected | Structural identity/hash/timing/convergence/diagnostic/output/model-use validation precedes manifest creation | Repository-backed artifact existence/readback remains a worker postcondition rather than a pure-domain check | Malformed receipt matrix and completed-promotion tests |
| WebXFOIL schema/adapter agreement | verified | `airfoilIdentity.ts`; `toolDescriptors.ts`; `engineeringProgramWebXfoilAdapter.ts` | Canonical parser contract/adapter parity tests cover supported and rejected identifiers | One parser normalizes and validates NACA identity for planner and adapter | Coordinate-file airfoils remain a separately validated binding path | Contract/adapter parity tests |
| WebXFOIL convergence promotion | verified | `webXfoilResultValidation.ts`; `engineeringProgramWebXfoilAdapter.ts`; `engineeringProgramWebXfoilAdapter.test.ts` | Real bundled WASM valid and non-converged/invalid cases fail closed | Finite values, point completeness, convergence, and requested-case binding are promotion postconditions | Broader aerodynamic domains remain unvalidated | Actual bundled WebXFOIL success/failure fixtures |
| Independent aerodynamic validation | partial | `aerodynamicValidation.ts`; NASA fixture metadata | Real bundled WebXFOIL and immutable independent NASA force data | Domain and metric gates | Reject duplicate-alpha inflation and add cross-platform tolerance evidence | Unique-alpha coverage test |
| Embedded toolchain manifest/hash | partial | `engineeringToolchain.ts`; install script and tests | Tamper/missing-manifest tests exist | Manifest and executable hash verification | Qualify install size/path/symlink/concurrency/atomicity matrix | Interrupted/concurrent install tests |
| Engineering-specific offline gate | partial | `aerospace:verify`, `aerospace:eval` | 70-test AetherAeroBench passes with real bundled WebXFOIL and immutable public NASA data | Units, frames, model, receipt validation, routing mechanics, and real WebXFOIL | Keep product evaluation separate until the remaining Phase 2 integrity blockers are closed | No-credential offline aggregate |
| Versioned searchable tool catalog | partial | `aerospaceToolMetadata.ts`; `aerospaceToolRouting.ts` | 1,000 synthetic routing mechanics | Hard filters and deterministic top-k | Production providers, version resolution, shadow comparison | Held-out recall and schema-byte metric |
| Baseline-aware engineering memory | absent | `memoryPromotion.ts`; aerospace state is not wired | No persisted receipt/baseline promotion gate | Generic eligibility checks | Defer until authoritative receipt and invalidation are complete | Cross-project leakage and stale baseline |
| Evaluated procedural skill promotion | absent | No production implementation | Not applicable | None | Defer until repeated held-out/adversarial verification exists | Replay, rollback, dependency compatibility |
| Bounded specialist WorkOrder | deferred | No required Phase 1 implementation | Not applicable | Fixed swarm is prohibited | Design only after mutable-resource ownership is proven | Conflict and ownership tests |

## Implementation evidence (2026-07-15)

The capability-table rows updated to `verified` above supersede their original review status. The implementation did not write to the live `.aetherops` root and did not use product mock success or a fallback solver.

- Operational schema v11 adds `tool_side_effect_reservations` through checksum-verified migration `operational-tool-side-effect-reservations-v11` (`55959399a8a0674f7452a01ce6b1d11bbc350359844687aaaee5b9d75fc3cd35`). Reservations are project scoped and move through `reserved`, `applied`, `not_applied`, or `ambiguous`; ambiguous response loss is blocked instead of retried silently.
- `durableSideEffectExecution.integration.test.ts` uses a real Worker thread, SQLite database, ToolRunner, and filesystem workspace. It injects loss after the external body completes, observes an ambiguous reservation, rejects the independent retry, and asserts exactly one external execution.
- Direct engineering now enters the same project FIFO, fenced attempt, staging, verification, promotion, checkpoint, event, and terminal-transition path as other durable work.
- HTTP and browser network paths bind URL-policy decisions to connect-time address validation. RSS discovery no longer uses unbounded raw text acquisition.
- Terminal jobs cannot retain queued/running tool attempts. Lease expiry and non-completed terminal transitions settle attempts and side-effect reservations in the same Storage Worker transaction.
- The full regression suite passed with 188 files and 1,019 tests in 107.78 seconds. The production build passed after the same source changes.

An isolated OS-temporary migration CLI rehearsal produced this sequence without touching live data:

```text
check needs-apply
apply applied
verify verified
apply already-applied (applied=false)
rollback rolled-back
check needs-apply
source SHA-256 da74e8849995a4dd0cc4357b187289c427a41fe88a8ec3c653a9626da4516f00
target manifest SHA-256 aab9d55fed5dbe14af4f67229107ca0a20a4c4e70a717c0a47bcedffcc3f64f9
```

Final offline gates run after implementation:

- format, lint, architecture (720 modules, 3,066 dependencies, zero violations), module size (768 modules), stylelint, CSS-token, typecheck: passed.
- `selftest:blocked`: passed in 23.5 seconds after the final domain-validation changes.
- `autonomy:verify -- --profile offline`: passed in 23.7 seconds after the final domain-validation changes.
- `harness:verify`: passed, including server-process restart; product evaluation remained explicitly `NOT_EVALUATED`.
- `harness:eval`: harness passed; product remained explicitly `NOT_EVALUATED`.
- `aerospace:verify`: 70/70 passed in 2.758 seconds with receipt SHA-256 `73ae8488a363d767db89ca24fe2f0e913ff9c2342def2b60820c99344d4712ed`.
- `aerospace:eval`: 70/70 passed in 2.840 seconds with receipt SHA-256 `b84f247719bae20e37ac3c482491199e5309aa33853824102d95ed5acbe8e492`.
- Doctor reported `Offline ready: true` and `Live ready: false`. Live Codex is blocked by the currently selected model/reasoning-effort combination, external search is disabled, and native engineering commands are unavailable. No live result is claimed.

## Residual blockers

The following review rows remain `partial`, `absent`, `disproved`, or `deferred` and are not represented as solved: persisted configuration baselines and invalidation, coefficient reference geometry on every promoted result, repository-backed artifact readback for every engineering receipt, cross-platform aerodynamic tolerance evidence, full embedded-toolchain installation hardening, production held-out tool-catalog evaluation, baseline-aware memory, evaluated procedural skills, and specialist WorkOrder ownership. These are later-phase integrity or harness milestones; adding their placeholder tables or success paths is intentionally deferred.

## Implementation decision

Phase 1 is the only implementation phase authorized by this review. Existing controls will be extended instead of duplicated. Phase 2–6 findings remain documented blockers; no placeholder interfaces, tables, or production success paths will be added for them before Phase 1 gates pass.

Phase 1 order:

1. Make failed/partial terminal disposition atomic.
2. Close durable admission synchronously when server drain begins.
3. Propagate cancellation through direct engineering and eliminate unfenced late promotion.
4. Cover initial HTTP policy/fetch with the caller signal and one deadline.
5. Bound and policy-check browser RSS acquisition.
6. Bound SSE drain waits by connection abort and replay deadline.
7. Add deterministic crash/race tests and rerun the complete offline baseline.
