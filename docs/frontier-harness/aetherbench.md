# AetherBench M0

AetherBench is AetherOps' offline evaluation and trace-replay boundary. It measures whether the harness contracts, deterministic validators, and replay logic behave consistently. Its default runtime does not call a live provider and its success is not evidence that the production research agent succeeded.

## Commands

```text
npm run harness:verify
npm run harness:eval
```

Both commands compile the server TypeScript graph and load only `dist-server/core/testing/harness/public.js`. Missing compiled output is `NOT_READY`; the wrapper never imports TypeScript source and never falls back to another runtime.

- `harness:verify` validates case and trace schemas, partition coverage, the immutable historical baseline reference, deterministic replay, and artifact sanitization.
- `harness:eval` executes the offline deterministic evaluation cases and grades them with deterministic acceptance criteria.

The default output root is a new ignored directory below `.tmp/harness/<command>-<timestamp>-<pid>/`. `--output-root <path>` may select another path inside `.tmp/harness`. Paths outside that boundary are rejected.

## Evidence classes and verdicts

Every report separates harness health from product evidence.

```json
{
  "harnessVerdict": "PASS",
  "harnessMechanicsVerdict": "PASS",
  "m0ReleaseReadiness": "READY",
  "releaseBlockers": [],
  "productVerdict": "NOT_EVALUATED",
  "productionSuccessEligible": false,
  "evidenceClass": "deterministic_test_runtime"
}
```

A deterministic test-runtime pass means only that the scripted fixture, evaluator, and replay contract passed. It cannot become a product pass, a promotion decision, or a live-provider claim. Unsupported capabilities fail explicitly; no skipped case, fallback provider, synthetic completion, or zero substituted for an unmeasured metric is accepted.

`harnessMechanicsVerdict=PASS` alone does not imply M0 release readiness. Readiness also requires the exact-base deterministic capture described below to remain measurement-complete and hash-valid. If that capture is absent or invalid, `INCOMPLETE_A0727F2_BASELINE` is emitted; if harness mechanics fail, `HARNESS_MECHANICS_NOT_PASSING` is emitted separately.

## Partitions

Fixtures are separated by purpose and each case declares exactly one classification.

- `seed`: visible development cases.
- `held_out`: execution inputs are supplied without evaluator-only expected observations; acceptance is applied only after execution.
- `adversarial`: prompt injection, stale/cross-project memory, and dangerous-tool decoys.
- `regression`: minimized reproductions of prior failures.

The initial suite covers tool discovery, tool composition, long-horizon resume, memory scope, memory freshness, tool-output injection, engineering, research, multi-agent conflict, and idempotent side effects. Runtime input never receives model-grader rubrics or evaluator-only observations.

The held-out execution, deterministic provider plan, and oracle JSON files are independently hash-bound in their partition manifest. The research case and its plan are absent from compiled visible defaults. After the raw files pass byte-count and SHA-256 verification, the wrapper validates the oracle-free execution/plan separately, injects the verified source hashes into in-memory `EvalExecutionCase` and `EvalOracle` envelopes, and combines nine visible defaults with one external held-out case. This avoids a self-referential file hash while preserving exact provenance. Only the oracle-free execution envelope reaches the provider boundary.

## Historical `a0727f2` baseline

`tests/fixtures/harness/baseline/a0727f2/manifest.json` anchors the current offline capture to the following public commit:

```text
a0727f2d5846b53717847ff908c411c24ab29d80
```

The same manifest references the existing immutable `gpt-5.6-sol/high` `0/2` failure fixture and its autonomy scorer by path, byte count, version, and SHA-256. Scorer drift fails verification. The fixture was present at `a0727f2`, but its originating execution commit is unknown and therefore remains `null` with an explicit reason. Its precision 7/9, recall 7/7, invalid-argument observation, and exact-case 0/2 metrics are scorer reproduction only, never a current product baseline or product success.

The anchored command record separately preserves `npm test` (108 files/569 tests, PASS), offline autonomy verification (PASS), and the blocked self-test (FAIL on the known compact run-bar geometry checks). The failure is not skipped or converted to a pass. This historical command record remains `PARTIAL_RECORDED / NOT_EVALUATED`; it is not rewritten by the newer capture.

The historical record alone is insufficient for the M0 release gate. The separately versioned exact-base capture supplies the missing measurements without relabeling the historical live failure or claiming production success.

### Exact-base deterministic instrumentation capture

Baseline v2 is captured manually from an exact `git archive` of commit `a0727f2d5846b53717847ff908c411c24ab29d80` and tree `f30864f7fae5fd91bb3d0f9daf1f11d38cba35aa`. The external runner imports and executes that archive's legacy orchestration, tool runner, SQLite store, and durable queue modules; it does not rewrite tracked base source. Run the capture with:

```text
npm run harness:capture-baseline -- --promote
```

The manual command bootstraps the official Windows x64 Node `v22.16.0` archive below `.tmp/harness/toolchains`, verifies both its pinned SHA-256 and the matching official SHASUMS line, installs the exact lockfile with scripts disabled, and runs with outbound network blocked. Normal `harness:verify` never downloads a toolchain or calls a provider.

The promoted `a0727f2-v2` fixture is a separate `deterministic_instrumented_legacy_runtime` evidence class. Its 22 receipt hashes bind success rate (1/2), tool-selection accuracy (3/7), invalid arguments (1/5), retries (0), duplicate side effects (0), versioned benchmark-context tokens (5,129), canonical output bytes (8,294), logical latency (29 ms), SQLite/durable restart readback (true), and human intervention (0). The invalid-argument denominator includes both strict planning validations and tool attempts, so a plan rejected before execution cannot disappear from the rate. Verification recomputes every scalar from those receipts and rejects edited metrics, absolute paths, raw prompts/responses, or credential-like values.

Baseline v2 can close only the incomplete-measurement blocker. It remains `NOT_EVALUATED`, is never eligible as production success, and does not replace or relabel the historical live `0/2` fixture whose source commit is unknown.

## Artifacts

Each command emits only:

```text
harness-report.json
trace-events.jsonl
harness-report.md
manifest.json
```

Structured data is sanitized before JSON, JSONL, or Markdown rendering. The manifest records the SHA-256 and byte size of every preceding artifact. Prompt text, provider responses, stdout/stderr, credentials, cookies, tokens, user file content, and absolute local paths are not report fields.

Trace rows are canonicalized by classification, case ID, seed, and event sequence before export. Parallel scheduling therefore cannot change trace or report ordering. The default deterministic runtime is CPU-light; bounded asynchronous case execution is not described as multicore execution.

## Baseline and product comparison rules

- Compare only the same case version, fixture hashes, budget, evaluator version, and evidence class.
- Evaluator changes create a new baseline version; they never overwrite an existing baseline.
- A baseline reproduction verdict and a product promotion verdict are separate fields.
- Deterministic validators, schema/state validation, artifact diff, and test/query receipts take precedence over any model grader.
- A model grader cannot turn a deterministic failure or an unmeasured capability into a pass.
