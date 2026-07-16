# `a85cbaf` Residual-Risk Plan

Generated: 2026-07-15 (Asia/Seoul)

## Review boundary

- Requested and resolved base: `a85cbaf197a4bf42ae3e98c6146f03e40551397f`.
- Review branch: `codex/aetherops-integration-verification`.
- `HEAD` matched the requested base when this plan was created.
- The tracked worktree and index were clean. The existing user-owned untracked roots
  `docs/literature-review-2026-06-27/`, `output/`, and `tmp/` were left untouched.
- The live `.aetherops` root is evidence only. No migration apply, rollback, or product write is
  authorized by this plan; cutover remains an explicit user-approval gate.
- Status values in the matrix are evidence classifications, not completion claims:
  `verified`, `partial`, `absent`, `disproved`, or `deferred`.

## Implementation progress (2026-07-16)

- The Phase 1 storage boundary and Phase 2 CAS/readback slice are implemented on the working tree:
  immutable project baseline revisions, optimistic active-baseline selection, deterministic stale
  dependency marking, strict result-kind promotion policy, Storage Worker transaction enforcement,
  CAS-bound engineering receipts, bounded artifact readback, restart verification, and additive
  operational migrations v12-v14.
- Terminal promotion rejects missing/stale/cross-project baselines, missing aerodynamic references,
  unit/frame omissions, non-convergence, outside-domain results, forged postcondition receipts,
  artifact mismatches, and stale lease ownership. Baseline identity is frozen in new research and
  engineering jobs and checked across checkpoint/resume lineage.
- Engineering promotion now derives execution media and model-card identity from independently
  checked runtime receipts. Bundled WebXFOIL is pinned and package-identity checked at `0.1.1`, and
  bundled Codex CLI workspace output is accepted only with the locked `0.144.1` trace. Native
  XFOIL, SU2, OpenVSP, XFLR5, mesh/modeling, and all-target probes remain fail-closed before process
  or filesystem side effects because no equivalent durable runtime-version receipt exists yet.
- The execution registry and its legacy server-runtime preflight now share that fail-closed boundary.
  `all`, native, and modeling preflight requests return an explicit runtime-receipt `NOT_READY`
  result without running a probe; only the pinned WebXFOIL static receipt is accepted. Native
  command-template validators remain covered independently so the readiness gate does not hide their
  input-contract regressions.
- A WebXFOIL promotion no longer copies a request or baseline geometry hash into the result receipt.
  The same solver run saves the post-`PANE` coordinate set, hashes its canonical coordinates, and
  binds that receipt to a second hash over the complete polar rows, request, convergence state, and
  pinned runtime. Promotion recomputes the polar receipt from exactly one paired full artifact before
  any CAS object is materialized. Its artifact and evidence outputs are both `polar` results with the
  same `airfoil_geometry` and `aerodynamic_reference` dependencies.
- A full-suite regression exposed that verified fetched coordinates were bound into the plan but the
  registry still executed its pre-binding normalized request. The registry now normalizes the bound
  plan again, so the durable coordinate binding ID used by WebXFOIL is the one produced from the
  validated source and SHA-256 receipt.
- Terminal CAS materialization uses owner-scoped pending claims covering project, job, durable
  attempt, output kind, and output ID. Per-hash locks, versioned journals, exact response-loss replay,
  restart reconciliation, and warning-only post-commit cleanup prevent another owner or an ambiguous
  retry from claiming an object. Reference enumeration is streaming and mutation work is bounded,
  although a reconciliation pass still scans the complete CAS object set.
- Terminal promotion, artifact events, job status, and project snapshot events share one Storage
  Worker transaction. Baseline activation and its project snapshot event also share one transaction.
- Operational migration v13 adds a Storage Worker-owned, immutable, project-local revision ledger.
  Project mutations, baseline activation, job transitions, and durable SSE events allocate and link
  revisions in the same transaction; exact replay reuses the receipt and never advances the head.
- Operational migration v14 adds a durable project-mutation journal paired with immutable legacy-DB
  receipts. Project and session writes now use one per-project saga with request hashes, expected
  revisions, snapshot hashes, startup recovery, pending-read barriers, and commit-before-response-loss
  reconciliation. Cross-database verification rejects split receipts, stale bases, malformed command
  envelopes, non-finite JSON, and drifted active readback.
- Baseline activation authorization is serialized with settings mutations and is revalidated in the
  Storage Worker transaction against the current project policy and revision. Its event identity is
  project-bound, and an uncertain worker response is reconciled through durable event readback plus an
  exact replay before the live SSE event is published.
- End-to-end research visibility is still **partial**: the legacy orchestrator writes tool outputs and
  derived report/memory state before the terminal promotion transaction. A late promotion, lease, or
  canonical-terminal failure can therefore leave uncommitted engineering observations in legacy
  stores. Closing that gap requires a job-scoped provisional generation, not a local filter.
- Migrations v12-v14 are checksum-bound and covered by populated v2/v4/v8/v11 forward upgrades,
  verification, zero-change reapply, recovery and rollback tests, same-name trigger-body drift,
  project-revision semantic readback, and cross-database project-mutation receipts. The live
  `.aetherops` target has not been modified.
- Exact command receipts and final test counts are recorded only after the last completed gate run;
  this document does not infer pass status from an earlier run.
- Provisional-generation cutover, live migration, capability readiness, cross-platform tolerance,
  held-out catalog evaluation, and Git/report evidence coupling remain explicit backlog items in
  `docs/engineering/residual-risk-backlog.md`. No placeholder schema or inactive production path was
  added for them.

## Evidence matrix

| Capability                                      | Status    | Evidence                                                                                                                                                                                                                                | Reproduction                                                                                                                                      | Existing control                                                                                                         | Gap                                                                                                                              | Planned change                                                                                                                                                                                   | Tests                                                                                                                                         |
| ----------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Report-to-Git integrity                         | disproved | `docs/engineering/22ad650-review-and-plan.md` still identifies `22ad650` as HEAD while the reviewed tree is `a85cbaf`                                                                                                                   | `git rev-parse HEAD`; inspect the report header                                                                                                   | Human-authored baseline line                                                                                             | Reports can remain apparently current after source changes                                                                       | Generate a bounded Git metadata receipt containing commit, tree hash, dirty-state classification, generator version, and report hash; fail release checks for stale/mismatched metadata          | Metadata unit tests; dirty/staged/untracked matrix; CI stale-report failure                                                                   |
| Operational migration chain                     | partial   | Operational migrations v12-v14 are checksum-bound and install baseline/promotion/CAS, project revision receipts, and the cross-database project-mutation journal                                                                        | Isolated v2/v4/v8/v11 apply/verify/reapply/rollback tests, checksum mismatch, object drift, semantic readback, stale-base and split-receipt tests | Lock, WAL checkpoint, backup/manifest, integrity, semantic verification, and cross-database hashes                       | The live root has no owner-authorized v14 cutover                                                                                | Run an owner-approved clone-of-live rehearsal and then a separate cutover/rollback window                                                                                                        | Populated forward upgrades; idempotent second apply; crash recovery; rollback/readback; no live apply                                         |
| Configuration-baseline domain model             | verified  | `configurationBaseline.ts` validates identity, revisions, canonical content hash, provenance, units/frame and deterministic dependency invalidation                                                                                     | Core validation and change-analysis tests                                                                                                         | Provider-neutral pure domain policy                                                                                      | No known Phase 1 domain gap; later tolerance/readiness policy remains separate                                                   | Keep SQLite and provider types outside core                                                                                                                                                      | Canonical hash, revision, provenance and invalidation matrix                                                                                  |
| Persisted, versioned project baseline           | verified  | v12 repositories persist immutable baseline revisions plus one optimistic project-active pointer; new jobs freeze the exact identity and checkpoint/resume lineage                                                                      | Repository restart, ownership, immutable-trigger, activation rollback and resume-lineage tests                                                    | Exact project/id/revision/content-hash readback                                                                          | Live data has not been cut over                                                                                                  | Preserve the repository and include it in the owner-approved v14 cutover rehearsal                                                                                                               | Ownership, revision conflict, immutable update/delete, activation event rollback, restart readback                                            |
| Persistent project snapshot revision            | verified  | v13 persists immutable revision receipts, heads and event links; v14 project/session sagas and baseline activation advance them atomically and replay exactly                                                                           | Concurrent mutations, rollback, response loss, restart recovery, interleaved SSE and version-gap tests                                            | Storage Worker allocation, optimistic expected revision, content-hash event identity, and readback                       | Legacy research writes before terminal promotion are not yet revision-bound                                                      | Complete the provisional-generation cutover so every visible research derivative enters one committed revision                                                                                   | Revision concurrency/exact replay/restart plus provisional visibility fault matrix                                                            |
| Baseline-gated engineering promotion            | partial   | Storage Worker terminal transitions validate the fenced job/attempt/output link, current baseline, dependency hash, policy receipt, CAS identity and tool postcondition in one transaction                                              | Promotion policy, atomicity, lease, exact replay and terminal snapshot-event tests                                                                | Strict result-kind policy and immutable promotion receipt                                                                | Legacy orchestration can consume the output before this transaction; the storage promotion itself is gated                       | Move research writes into a provisional generation committed with promotion visibility                                                                                                           | Missing/stale/cross-project baseline rejection; lease race; retry/idempotency; state/event/promotion atomicity; provisional visibility faults |
| Promotion-before-consumption boundary           | disproved | `ExecutionOrchestrator.persistToolResults()` writes legacy primary stores before `registerDurableResearchLoopHandler` prepares and commits durable promotions                                                                           | Inject a failure after ExecuteTools and before terminal `jobs.finish`; inspect project/global rows and report inputs                              | Tool DAG staging and atomic terminal promotion exist independently                                                       | Late terminal failure can leave raw and derived unpromoted engineering data visible to normalization, report, memory and search  | Add a job-scoped provisional research generation and make terminal promotion plus generation visibility the only commit point; committed readers must ignore provisional/quarantined generations | Fault injection after ExecuteTools, normalize, finalize, promotion and terminal event; restart/quarantine/readback matrix                     |
| Coefficient reference geometry                  | verified  | Polar/coefficient promotion requires the active baseline aerodynamic reference hash and the result-kind policy validates required coefficient/reference metadata                                                                        | Promotion-policy mutation matrix and repository transaction tests                                                                                 | Canonical baseline/reference hashes and strict units/frame/model/run checks                                              | Cross-platform tolerance evidence remains deferred; it does not weaken reference enforcement                                     | Keep reference enforcement in the Storage Worker transaction                                                                                                                                     | Missing/non-positive area/chord/span/reference point/axis/dynamic-pressure/unit tests                                                         |
| Terminal content-addressed storage              | verified  | `terminalCasStore.ts` and `terminalCasFilesystem.ts` use SHA-256 locators, bounded reads, no-follow opens, symlink checks, fsync and atomic rename; engineering receipts bind the CAS object to baseline/reference/output-link identity | CAS, promotion and terminal attestation suites                                                                                                    | Content hash and byte length are authoritative, not a caller path                                                        | Unreferenced but valid CAS objects require bounded startup reconciliation after a crash                                          | Reuse the existing journal/reconciliation path; never infer success from object presence                                                                                                         | Tamper, truncation, oversized content, locator/hash mismatch, pending-journal recovery                                                        |
| Restart-safe terminal artifact readback         | verified  | Engineering artifact readback resolves an immutable promotion, revalidates project ownership, active/non-stale baseline, receipt hash and CAS bytes, and returns a bounded typed excerpt                                                | Repository reconstruction and restart tests                                                                                                       | Persisted promotion/CAS identity plus bounded read receipts                                                              | Live v14 data has not been cut over                                                                                              | Preserve fail-closed readback and cover clone-of-live restart during the cutover rehearsal                                                                                                       | Restart, moved-path, symlink, cross-project, oversized and stale-baseline readback tests                                                      |
| Engineering result provenance                   | partial   | Immutable promotion receipts bind actual WebXFOIL `0.1.1` or Codex CLI `0.144.1` runtime evidence, job/attempt/output link, baseline/dependency/reference hashes, postcondition and CAS identity                                        | Package-lock/package identity, tool-run/output trace agreement, exact readback, immutable conflict, duplicate retry, restart and tamper tests     | Promotion rejects caller-declared or baseline-only tool versions; stable receipt and content hashes remain authoritative | Derived legacy report/memory records do not yet retain complete origin and promotion lineage                                     | Propagate lineage through the provisional generation and make reports consume promotion read models                                                                                              | Runtime-version mismatch/missing receipt; exact readback; immutable trigger; duplicate/conflicting receipt; derivative-lineage completeness   |
| Codex model/effort runtime contract             | verified  | Shared model catalog and API schemas validate supported combinations; the provider forwards model, effort and timeout without model fallback                                                                                            | Provider and contract tests                                                                                                                       | Central catalog, strict settings validation, explicit provider errors                                                    | Doctor and live legacy-settings inspection use a separate normalization path                                                     | Make doctor consume the same catalog/default-normalization contract and report configured, supported, authenticated and entitlement-checked states separately                                    | Legacy settings; unsupported effort; access-not-checked; entitlement rejection; no fallback                                                   |
| Live Codex readiness diagnosis                  | partial   | Live doctor reports `unsupported_reasoning_effort` for legacy settings lacking effort although runtime normalization supplies defaults                                                                                                  | Run live doctor read-only and inspect legacy selected fields                                                                                      | Structured doctor result                                                                                                 | Duplicate capability logic creates a false negative and does not distinguish static support from account access                  | Share the canonical descriptor/normalizer with doctor; retain explicit `not_checked` rather than inferring entitlement                                                                           | Offline doctor fixtures and process-harness status tests                                                                                      |
| Search readiness and native-command capability  | partial   | Planner descriptors, RPC preflight/enqueue, direct jobs, research authorization, and the engineering registry all reject native/modeling targets that lack a durable runtime receipt; WebXFOIL/Codex require exact pinned versions      | Marker executable remains uncalled; native/all-target side-effect count stays zero; pinned-version match/mismatch and blocked-job tests           | Capability intersection, descriptor filtering, frozen active baseline, and shared fail-closed promotion-readiness policy | Search and general native diagnostics still lack one provider-neutral version/hash/license/sandbox receipt with TTL/invalidation | Extend the existing diagnostics boundary without weakening the new hard execution filter                                                                                                         | disabled/not-configured/not-installed/version-mismatch/license/sandbox/ready matrix; marker side-effect zero                                  |
| Aerospace cross-platform reproducibility policy | absent    | Deterministic fixtures exist, but no repository-wide OS/architecture tolerance policy is attached to promoted results                                                                                                                   | Search aerospace verification and result validators                                                                                               | Individual exact/hash checks                                                                                             | Floating-point results have no explicit exact-vs-tolerance classification across Windows/Linux/CPU variants                      | Define quantity-specific absolute/relative/ULP policy and media identity; exact hashes remain required for deterministic canonical fixtures                                                      | Windows/Linux matrix; boundary values; NaN/Inf; deterministic hash class                                                                      |
| Aerospace catalog/router mechanics              | partial   | `aerospaceToolMetadata.ts` and `aerospaceToolRouting.ts` hard-filter capability, frame, discipline, fidelity, license and risk before bounded ranking                                                                                   | `npm run aerospace:verify` and routing tests                                                                                                      | Bounded 3–8 descriptor exposure and deterministic sorting                                                                | Catalog has no versioned snapshot, held-out routing set or regression threshold; tokenizer includes a suspicious non-ASCII range | Version the descriptor snapshot, repair tokenization, and add held-out cases with precision/recall and zero-policy-violation gates                                                               | Korean/English tokenization; stable ranking; held-out compatibility and denial cases                                                          |
| Held-out catalog evaluation                     | absent    | Existing routing tests are authored beside the implementation                                                                                                                                                                           | Inspect `aerospaceToolRouting.test.ts`                                                                                                            | Focused unit tests                                                                                                       | No independently maintained unseen fixture or report receipt                                                                     | Add an immutable held-out fixture with source/license/hash metadata and a deterministic evaluator                                                                                                | Fixture hash; mutation sensitivity; minimum recall/precision; policy-violation zero                                                           |
| CI/release evidence coupling                    | partial   | CI runs dependency, static, type, unit, autonomy, build and blocked selftest gates                                                                                                                                                      | Inspect `.github/workflows/ci.yml`                                                                                                                | Pinned actions, read-only permissions and concurrency controls                                                           | CI omits isolated migration lifecycle, baseline/promotion readback, aerospace evaluation and report-Git integrity gates          | Add only deterministic offline gates after their production paths exist; keep live providers/nightly checks separate                                                                             | Linux full offline; Windows storage/launcher; migration lifecycle; generated receipt verification                                             |
| Real `.aetherops` cutover                       | deferred  | Live `migrate:check` indicates an unapplied state; no approval to mutate the live root was supplied                                                                                                                                     | Read-only `migrate:check` and `migrate:verify`                                                                                                    | Explicit migration and backup commands                                                                                   | Production data has not been upgraded or read back under the new schema                                                          | Stop after a verified temporary-root dress rehearsal and produce a cutover/rollback runbook; await explicit approval                                                                             | Temp-root clone/fixture dress rehearsal only in this phase                                                                                    |

## Phase 1: persisted baseline and transactional promotion

The first implementation slice extends the existing storage worker and terminal transition rather
than creating a parallel engineering database or promotion path.

1. Add an immutable `engineering_configuration_baselines` record with a project-local monotonically
   increasing revision, canonical content hash, provenance identifier and timestamps.
2. Add a project-active baseline pointer with optimistic revision semantics. Activating a new
   baseline computes deterministic invalidation from the prior revision; it does not delete prior
   results.
3. Add an immutable `engineering_result_promotions` receipt keyed to the existing output-link and
   attempt. It records result kind, baseline ID/revision/hash, tool name/version, execution-media
   identity, optional reference geometry plus its canonical hash, and the promoted content hash.
4. Extend `StorageOutputPromotion` with a discriminated engineering attestation. Ordinary research
   artifacts keep their existing shape. Engineering outputs cannot omit the attestation.
5. In the existing Storage Worker transaction, verify the fenced job, project and attempt; completed
   attempt state; output-link ownership; current baseline identity; coefficient reference
   requirements; and CAS/content hash before committing receipt, job state, snapshot revision and SSE
   events.
6. Treat a changed active baseline as an explicit stale relation. Never rewrite or silently relabel a
   prior result.

No schema object will be added until its repository and production transaction are implemented in
the same slice.

## Phase 2: artifact receipt and readback

1. Reuse the existing terminal CAS, attestation repository and bounded readback leases.
2. Resolve an engineering result by immutable output-link/receipt ID, then verify project ownership,
   CAS locator, byte length, SHA-256, attempt lineage, baseline existence and stored reference hash.
3. Reject path traversal, symlinks/reparse points, cross-project aliases or claims, missing media
   identities, stale/corrupt receipts and oversized content. A path is never proof of identity.
4. Return a bounded typed read model. Do not expose raw provider responses, prompts, stdout/stderr or
   secret-bearing environment data.
5. Restart tests reconstruct repositories from SQLite and CAS only; in-memory objects are not accepted
   as evidence.
6. Reconciliation streams SQLite references and bounds each filesystem mutation, but its current
   object scan is `O(total CAS objects)` and has no persisted cursor. This is an explicit scale risk,
   not evidence of data loss or an authorization bypass.

## Later phases and cutover gate

- Capability readiness, tolerance policy, held-out catalog evaluation and generated report metadata
  follow the baseline/promotion and artifact-readback slices.
- The isolated migration rehearsal must cover check, apply, verify, zero-change reapply, rollback and
  semantic readback with recorded hashes.
- A live cutover is a separate operation requiring explicit user approval. The cutover receipt must
  identify the source manifest, backup, target schema checksums, readback result and rollback boundary.
- If the current implementation session cannot finish the later phases without weakening a required
  gate, unfinished work is recorded in `docs/engineering/residual-risk-backlog.md` with evidence and no
  placeholder tables or unused interfaces.

## Baseline command policy

The following commands are run after this plan is committed to the working tree and before the large
refactor. Missing package scripts are reported as absent rather than silently replaced. Where this
repository uses the canonical `aerospace:*` name instead of the requested `engineering:*` name, both
the absence and the executed equivalent are recorded.

```text
npm ci
npm run format:check
npm run lint
npm run architecture:check
npm run size:check
npm run stylelint
npm run css:tokens
npm run migrate:check
npm run migrate:verify
npm run typecheck
npm test
npm run build
npm run doctor
npm run selftest:blocked
npm run autonomy:verify -- --profile offline
npm run harness:verify
npm run harness:eval
npm run aerospace:verify
npm run aerospace:eval
```

Live Codex, external Search, browser and native engineering checks are not converted into offline
successes. Missing credentials, entitlement, network permission or binaries remain explicit
infrastructure/capability outcomes.

## Final offline verification receipts (2026-07-16)

- Node `22.22.2` and `npm 10.9.7` were used. Final `npm ci` installed 430 packages, audited
  431 packages and reported zero vulnerabilities; application and server typechecks then passed.
- `git diff --check`, `npm run format:check`, `npm run lint`, `npm run stylelint`, and
  `npm run css:tokens`: exit 0. Architecture check covered 815 modules and 3,704 dependencies with
  zero violations; size check covered 864 modules with no allowlist exception.
- The final full `npm test` run passed 224 files and 1,266 tests. The adversarial baseline-activation
  replay matrix separately passed 5 files and 26 tests against a real Storage Worker and SQLite; an
  independent review found no remaining reachable revision/capability replay bypass.
- `npm run build`: exit 0; the renderer transformed 2,011 modules and the server TypeScript build
  passed. `npm run selftest:blocked`: exit 0; report SHA-256
  `95f4c03c05f957a13fa51ba3d01b554ebf92023b0df2bc390d58d907bd2b896f`.
- `npm run autonomy:verify -- --profile offline`: exit 0. Report SHA-256
  `9d83e1aa4bf365c0bd38785477b3387f48e0a98ccc04d511404dc91b2dc26927`; its embedded sanitized
  `gpt-5.6-sol/high` 0/2 failure baseline is scorer input, not a current product-success claim.
- `npm run harness:verify` and `npm run harness:eval`: exit 0, including process-restart verification,
  but both explicitly report `product NOT_EVALUATED`. JSON report SHA-256 values are
  `eca649bdc1022fa7c8b0a309707ba3a76722e783e6efce7442502d24640d3669` and
  `f9650911cd6bdac65c7eb3c607e8cec11458e1e531ddc47994c6f2820aacd493`.
- `npm run aerospace:verify`: 115/115, external requests 0, bounded workers 4/16, semantic hash
  `0aaeb1a63d96cbd1f288e909430054ecdc4a360012b864d5e15daf39ad03c953`, receipt hash
  `26d18fa250b74ca412ef4528f7469c35dcc20dc8f42db95065d704c36f6d4b75`.
- `npm run aerospace:eval`: 115/115, external requests 0, bounded workers 4/16, semantic hash
  `00988e8a24472d6c32ecd7ee38099c7fc30bc7a4b1cc5e6d19b1f1a1555b0d64`, receipt hash
  `23f9028c32eca7db050610e07e17ca3eba1c446989e15caab9f5384e946fd371`.
- A direct final-build Clark-Y run with the immutable local fixture and bundled
  `webxfoil-wasm@0.1.1` produced three converged rows, zero network requests, post-`PANE` geometry
  hash `02ff4eeae0f648d2a4783a1784c17aaead1637ce1713bcc1000021878ff255db` (240 points), and full polar
  receipt hash `40480048c97d59f5e5eba5a7eaacba39579f376bbe7aa00295d0e3c529d785a3`.
- An isolated empty-root rehearsal completed check, apply, verify, zero-change second apply, rollback,
  post-rollback check and reapply. Source hash was
  `fe31392a32a0e079f9797594d505ce2cb74e59cd1ef82893d807a86de631fde1`; the active manifest SHA-256
  is `9dbdd4e6dc0c87e4318fe194c50790735721b8524bdcb780c946e11ec0ccda36`. No apply or rollback command
  was run against the live root.
- Final doctor: exit 0 and offline-ready. Port `0` is correctly reported as dynamic; Codex OAuth/CLI
  is locally ready with account access `not_checked`, while settings, embedding, Search, and native
  engineering programs are not configured. No credentialed provider, external browser/Search, or
  native solver smoke was run.
- The requested `engineering:verify` and `engineering:eval` package scripts do not exist. The
  repository's canonical `aerospace:verify` and `aerospace:eval` commands above were executed instead.
