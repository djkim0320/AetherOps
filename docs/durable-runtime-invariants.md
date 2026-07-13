# Durable runtime invariants

이 문서는 2026-07-14 기준 구현을 코드 변경 전에 감사한 결과다. `unknown`은 재현 테스트 없이 위반으로 간주하지 않는다.

|   # | Invariant                                                                               | Status    | Evidence                                                                                                                                                     | Reproduction test                                                          | Planned change                                                                                               |
| --: | --------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
|   1 | 동일 `projectId`의 job handler는 최대 하나만 실행된다.                                  | violated  | storage claim은 active status를 막지만 runtime에는 `activeProjects` guard가 없다. A가 DB를 terminal로 commit한 뒤 handler가 반환하기 전 B가 claim될 수 있다. | A가 `finish()` 후 barrier에서 대기하는 동안 같은 프로젝트 B를 enqueue한다. | full handler/finalization lifetime을 보호하는 runtime `activeProjects` guard와 SQLite guard를 함께 유지한다. |
|   2 | 프로젝트 실행 순서는 `(queuedAt, id)`의 결정론적 FIFO다.                                | violated  | `JobRepository.claimNext()`는 `priority desc, queued_at, created_at`으로 정렬하고 `id` tie-break가 없다.                                                     | 같은 timestamp의 300개 job 및 서로 다른 priority를 enqueue한다.            | priority를 lane FIFO에서 제거하고 `(queued_at, id)` index/query를 사용한다.                                  |
|   3 | 서로 다른 프로젝트는 전역 concurrency 한도 내에서 병렬 실행된다.                        | confirmed | `DurableJobRuntime.pump()`의 전역 `active < concurrency`와 기존 cross-project barrier test.                                                                  | 두 프로젝트 handler barrier가 동시에 active인지 검증한다.                  | bounded global concurrency를 유지한다.                                                                       |
|   4 | lease를 잃은 worker는 상태·checkpoint·attempt·event·promoted artifact를 기록할 수 없다. | violated  | `jobs`에 generation이 없고 `job.updateStatus`, checkpoint/event/trace command가 fence를 받지 않는다.                                                         | A claim→expiry→B reclaim/complete→A late return 순서를 강제한다.           | UUID worker instance와 `(jobId, attempt, owner, generation)` fence를 모든 worker write에 적용한다.           |
|   5 | 모든 worker write는 attempt와 lease generation으로 보호된다.                            | violated  | `src/server/runtime/storage/worker/typedProtocol.ts`의 write command에 expected fence가 없다.                                                                | owner가 같아도 generation이 다른 stale write를 시도한다.                   | `StorageJobFence`, `LeaseLostError`, fenced composite storage commands를 추가한다.                           |
|   6 | job 상태 전이와 대응 durable event는 한 SQLite transaction에서 commit된다.              | violated  | `DurableJobRuntime.settle()/fail()` 후 `appendEvent()`가 별도 storage request다.                                                                             | status commit 직후 publisher/storage fault를 주입한다.                     | terminal/control/claim transition과 event를 repository composite transaction으로 결합한다.                   |
|   7 | DB commit 뒤 in-memory publish가 실패해도 reconnect replay로 event를 복원한다.          | confirmed | trace runtime은 `event.append` commit 결과를 받은 뒤 emitter로 publish하며 `eventsAfter()`는 SQLite를 읽는다.                                                | subscriber throw/process boundary 뒤 `eventsAfter()` readback.             | publisher 예외를 격리하고 durable replay를 유지한다.                                                         |
|   8 | 완료된 step만 committed checkpoint를 만들고 step attempt와 event가 원자적이다.          | violated  | 일반 `commitCheckpoint()`는 attempt 상태와 결합하지 않고 checkpoint+event만 저장한다. failed quarantine은 checkpoint와 attempt를 별도 요청한다.              | checkpoint/attempt/event 중간 fault를 각각 주입한다.                       | completed/failed step composite command로 교체한다.                                                          |
|   9 | failed 또는 lease-lost step 산출물은 promoted 상태가 될 수 없다.                        | violated  | output promotion과 event는 fence 없이 실행되고 handler가 lease loss를 관찰하는 경로가 없다.                                                                  | A의 늦은 artifact promotion을 B reclaim 뒤 시도한다.                       | promote 직전 fenced transaction을 강제하고 lease loss 시 handler signal을 abort한다.                         |
|  10 | 재시작 시 모든 runnable project를 고정 limit 없이 발견한다.                             | violated  | `initialize()`가 `job.listQueued(limit: 1_000)` 한 번만 호출한다.                                                                                            | 1,001개 이상의 queued project를 seed한다.                                  | cursor 기반 `listRunnableProjectIds`를 끝까지 순회한다.                                                      |
|  11 | durable job은 프로세스 메모리 callback에 의존하지 않는다.                               | violated  | `enqueue(input, onRun?)`과 `work` map이 persisted job 실행 경로에 포함된다.                                                                                  | callback enqueue 후 runtime을 닫고 새 runtime에서 재생한다.                | durable enqueue에서 callback을 제거하고 등록 handler만 허용한다.                                             |
|  12 | shutdown 중에는 새 job을 claim하지 않고 active run을 bounded drain/abort한다.           | violated  | `close()`는 즉시 storage를 닫고 active run Promise를 기다리지 않으며 in-flight claim 이후 handler 시작 race가 있다.                                          | claim/handler/checkpoint barrier 중 `close()`를 호출한다.                  | `RUNNING → DRAINING → ABORTING → CLOSING_STORAGE → CLOSED` lifecycle과 active run tracking을 추가한다.       |

## 상태 전이 원칙

실제 공개 `JobStatus`는 `queued`, `running`, `pause_requested`, `paused`, `cancel_requested`, `aborted`, `interrupted`, `blocked`, `failed`, `completed`다. 전이는 중앙 state machine에서 검증하고 임의의 `job.updateStatus` patch는 worker protocol에서 공개하지 않는다. terminal 상태는 다른 terminal 상태로 바뀌지 않으며, completion commit이 먼저 성공한 뒤 도착한 cancel은 결과를 되돌리지 않는다.

## 오류와 관측성

durable failure에는 공개 가능한 code/message만 저장한다. 원본 Error, prompt, provider response, token, cookie, API key, 사용자 경로는 중앙 redactor를 통과하지 않고 job/checkpoint/event/SSE에 들어갈 수 없다. 로컬 diagnostics는 queue depth/age, active project/job, renewal 결과, lease loss/stale write, recovery scan, SSE buffer/replay, trace query, storage transaction latency를 high-cardinality metric label 없이 집계한다.

## 변경 후 검증 (2026-07-14)

위 표는 기준선 커밋 `810eb4b6d2ace6a9801ee2318e0383d7b1770679`을 변경 전에 감사한 기록이며 보존한다. 아래 표는 구현 후 동일 불변조건을 다시 검증한 결과다.

| # | Status | Enforced by | Deterministic reproduction |
| --: | --- | --- | --- |
| 1 | confirmed | `durableProjectLaneScheduler.ts:10`, `jobSchema.ts:55` | `durableJobRuntime.test.ts`, `durableControlRace.test.ts`의 project barrier와 partial unique index |
| 2 | confirmed | `jobRepository.ts:188`의 `(queued_at, id)` ordering과 lane index | 동일 timestamp/서로 다른 priority FIFO 테스트 |
| 3 | confirmed | `durableProjectLaneScheduler.ts:36`의 bounded active-project set | 같은 project A/B 직렬, 다른 project C 병렬 테스트 |
| 4 | confirmed | `jobRepository.ts:204`, `typedRuntime.ts:45` | A lease 만료 → B reclaim/complete → A의 late write 전부 `LeaseLostError` |
| 5 | confirmed | 모든 worker write의 `StorageLeaseFence`와 fenced transaction | owner가 같아도 attempt/generation이 다른 write 및 cross-job trace 거부 테스트 |
| 6 | confirmed | `jobAtomicOperations.ts:66`의 claim/control/step/terminal composite transaction | status/event/checkpoint/attempt 중간 fault rollback과 publish-failure replay 테스트 |
| 7 | confirmed | DB commit 후 `publishStoredEvent`, SQLite `event.after` replay | subscriber throw 및 commit 직후 restart 뒤 동일 sequence readback 테스트 |
| 8 | confirmed | `jobAtomicOperations.ts:241`, checkpoint exact-retry guard | divergent checkpoint data/output hash retry의 전체 rollback 테스트 |
| 9 | confirmed | terminal completion transaction 내부 promotion과 completed-attempt provenance 검사 | cancel/pause race 및 stale worker에서 promoted output·artifact event 0 테스트 |
| 10 | confirmed | `durableJobRuntime.ts:283`, cursor 기반 `job.listRunnableProjects` | 1,001개 project startup recovery와 no-progress cursor guard 테스트 |
| 11 | confirmed | `durableJobStore.ts:26`, startup handler registry | callback 없는 JSON payload restart 실행, 미등록 handler/비직렬 payload enqueue 거부 테스트 |
| 12 | confirmed | `durableJobRuntime.ts:313`의 drain/abort/close state machine | in-flight claim, grace completion, abort 무시, 동시 close, 즉시 reopen 테스트 |

운영 진단은 외부 telemetry 없이 `tools.diagnostics.reliability`에 bounded aggregate만 공개한다. 큐 프로젝트 표본은 기본 100/최대 500, SSE는 연결·현재/peak buffer·slow-consumer·replay, Storage Worker는 trace query와 atomic transaction의 count/rows/duration을 집계한다. ID, URL, prompt, payload 또는 secret은 metric label이나 누적 상태에 보존하지 않는다.
