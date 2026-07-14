# A0 foundation status

Baseline: `2906b4170414d821b10763c3b5dd2391f0fa9be9` on `codex/aetherops-integration-verification`.

Evidence class: source inspection plus provider-free tests against the current HEAD. The first combined run passed 172/173 tests; one web-server test timed out under process contention. Its unchanged standalone rerun passed 16/16, and the complete suite then passed 908/908. No timeout was increased and no assertion was weakened.

## Gate decision

The four mandatory A0 prerequisites are **verified**. Aerospace work may proceed additively, but this decision does not certify the application or establish aerospace-domain correctness.

| Foundation requirement                                  | Status   | Exact evidence                                                                                                                         | Executed test evidence                                                                                                                             |
| ------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actual response-stream byte limit                       | verified | `src/server/runtime/tools/boundedHttpBody.ts:32-59` rejects declared and streamed overflow and cancels the reader                      | `boundedHttpClient.test.ts` — exact boundary, declared overflow, chunked overflow, dishonest Content-Length, abort                                 |
| Original JSON response bytes preserved                  | verified | `src/server/runtime/tools/boundedHttpClient.ts:53` exposes `Uint8Array`; `boundedHttpBody.ts:71-81` decodes only after bounded capture | `boundedHttpClient.test.ts` — “returns the original JSON bytes at the exact boundary”                                                              |
| Cross-origin credential stripping                       | verified | `src/server/runtime/tools/boundedHttpClient.ts:10-18,255-276` strips credential headers and blocks cross-origin bodies                 | `boundedHttpClient.test.ts` — same-origin preservation, cross-origin stripping, sticky stripping, 307/308 body rejection                           |
| Redirect status allowlist                               | verified | `src/server/runtime/tools/boundedHttpClient.ts:9,276` permits only 301/302/303/307/308                                                 | `boundedHttpClient.test.ts` — redirect method matrix and unsupported 300/304/305/306                                                               |
| Non-loopback unauthenticated bootstrap blocked          | verified | `src/server/runtime/security/loopbackRpcSecurity.ts:55-59` refuses every non-loopback host before token bootstrap                      | `webServer.test.ts` — “refuses non-loopback host binding even when the retired opt-in is present”                                                  |
| Generic 500 detail redaction                            | verified | `src/server/http/errorBoundary.ts:14-49`; `src/server/runtime/security/traceSanitizer.ts:1-96`                                         | `errorBoundary.test.ts` — structured redacted diagnostic and nested cause redaction                                                                |
| Request ID and structured internal logging              | verified | `src/server/http/errorBoundary.ts:7-24`                                                                                                | `errorBoundary.test.ts` — contract-safe IDs and structured log fields                                                                              |
| Request Content-Type, Content-Length, timeout and abort | verified | `src/server/http/jsonBody.ts:1-176`                                                                                                    | `jsonBody.test.ts` — 14 boundary, timeout, UTF-8, abort and cleanup cases                                                                          |
| Browser text/screenshot/download/profile budgets        | verified | `src/server/runtime/browser/browserResourceBudget.ts:1-69`; bounded download client above                                              | `browserResourceBudget.test.ts` — per-item and aggregate limits                                                                                    |
| DNS rebinding/TOCTOU policy                             | verified | `src/server/runtime/browser/browserNetworkPolicy.ts:1-55`; shared `PublicUrlPolicy`                                                    | `browserNetworkPolicy.test.ts` — public navigation, rebinding rejection, redirect/subresource interception                                         |
| Boot-unique worker identity                             | verified | `src/server/composition/durableRuntimeConfig.ts:57` uses PID plus `randomUUID()`                                                       | `durableRuntimeConfig.test.ts` — runtime-bound worker identity and bounded configuration                                                           |
| Attempt and lease-generation fencing                    | verified | `src/server/runtime/storage/v2/jobRepository.ts:176-278`; fence includes job, attempt, owner and generation                            | `jobReliability.test.ts` — expired/stale/late writer rejection; `runStateStorageWorker.integration.test.ts` — expired and terminal fence rejection |
| No overlapping lease renewal rejection                  | verified | `src/server/composition/durableLeaseRenewal.ts:1-88`                                                                                   | `durableLeaseRenewal.test.ts` — slow renewal serialization and handled rejection                                                                   |
| One running handler per project                         | verified | `src/server/composition/durableProjectLaneScheduler.ts:1-128`; SQLite active-lane guard                                                | `durableProjectLaneScheduler.test.ts`; `jobReliability.test.ts` — one active lease holder per project                                              |
| Atomic status/attempt/checkpoint/event                  | verified | `src/server/runtime/storage/worker/typedRuntime.ts:47-82,237-238`; `jobAtomicOperations.ts:176-300`                                    | `jobAtomicity.test.ts` — injected rollback across claim, step, checkpoint, attempt and event                                                       |
| Cursor recovery beyond 1,000 queued jobs                | verified | `src/server/composition/durableJobRecovery.ts:5-16`; `jobRepository.ts:118-131`                                                        | `durableJobRuntime.test.ts` — “discovers runnable projects beyond the first 1,000 rows”                                                            |
| Durable handlers separated from transient callbacks     | verified | `src/server/composition/durableJobRuntime.ts:68,123-125`; registered handlers receive persisted request payloads                       | restart and crash tests in `durableJobRuntime.test.ts` and `durableRuntimeCrashMatrix.test.ts`                                                     |
| Durable pause/cancel authority                          | verified | storage control requests commit status and events before handler interruption                                                          | `jobReliability.test.ts` — atomic pause/cancel events; `rpcRouter.test.ts` — durable control before orchestrator                                   |
| Bounded graceful shutdown                               | verified | `src/server/composition/durableRuntimeShutdown.ts:3-27`; `src/server/http/serverDrain.ts:1-118`                                        | `durableRuntimeShutdown.test.ts`; `serverDrain.test.ts`; same-port restart in `webServer.test.ts`                                                  |
| SSE backpressure and replay budgets                     | verified | `src/server/http/v2/sseReplay.ts:50-201`; `sseDelivery.ts:1-154`                                                                       | `sseController.test.ts` — event/byte/time budgets, drain serialization, slow-consumer close, connection caps                                       |
| Trace cursor pagination and batch output read           | verified | `src/server/runtime/storage/v2/tracePagination.ts:27-143`; `traceRepository.ts:317-332`                                                | `tracePagination.test.ts`; `traceRepository.test.ts` — multi-attempt output query                                                                  |

## Baseline commands

| Command                      | Result                                |
| ---------------------------- | ------------------------------------- |
| `npm ci`                     | PASS; 430 packages, 0 vulnerabilities |
| `npm run format:check`       | PASS                                  |
| `npm run lint`               | PASS                                  |
| `npm run architecture:check` | PASS; 655 modules, 2,809 dependencies |
| `npm run size:check`         | PASS; 703 modules                     |
| `npm run stylelint`          | PASS                                  |
| `npm run css:tokens`         | PASS; 14 stylesheets                  |
| `npm run typecheck`          | PASS                                  |
| `npm test`                   | PASS; 164 files, 908 tests            |

## Known non-blocking risks

- Generic non-terminal `RunStateRevision` commits are not yet wholly expressed as worker-owned typed reducer events.
- Terminal CAS publish can leave orphan files after a late transaction failure, and directory-entry durability is weaker than SQLite authority on abrupt power loss.
- These are P1 reliability risks from the frontier-harness audit. They must be resolved before aerospace terminal artifacts are promoted, but no current A0 test disproves the four mandatory gate conditions above.
