# AetherOps Self-Test Report

Generated: 2026-05-28T14:32:31.525Z  
Workspace: `D:\AI\AetherOps`  
Data root: `D:\AI\AetherOps\.tmp\aetherops-selftest`

## 1. Environment

- Commit hash: `d082cf7`
- Branch: `main`
- Node.js: `v22.22.2`
- npm: `10.9.7`
- OS: `win32 x64`
- Package engine: `>=22.16.0`
- Engine check: PASS
- Dirty files before self-test: `M .gitignore`, ` M README.md`, ` M package.json`, ` M src/core/runtimeRequirements.ts`, ` M src/server/runtime/orchestratorStrictExecution.test.ts`, ` M src/server/webServer.ts`, `?? docs/`, `?? output/`, `?? scripts/doctor.mjs`, `?? scripts/selftest.mjs`

## 2. Static Checks

| Check | Result | Seconds |
| --- | --- | --- |
| npm run typecheck | PASS | 3.7 |
| npm test | PASS | 5.27 |
| npm run build | PASS | 7.63 |

### Grep Invariants

- PASS: production mock/fallback adapters
- PASS: legacy RPC gate - 212: if (process.env.AETHEROPS_ENABLE_LEGACY_RPC !== "true") { 215: console.warn(`[AetherOps] Legacy RPC method ${method} was called. Set AETHEROPS_ENABLE_LEGACY_RPC=false to block old clients.`);
- PASS: WebSearchTool no evidence policy - 33:export class WebSearchTool implements ResearchTool { 60: evidence: [], 126: evidence: [], 222: evidence: [], 267: evidence: [], 287: evidence: [], 451: evidence: [],
- PASS: ProjectContextSnapshot enforcement - src/core/hybridRetrievalEngine.ts:3:import type { HybridContext, ProjectContextSnapshot, ResearchSnapshot } from "./types.js"; src/core/hybridRetrievalEngine.ts:8: async buildContextFromProjectContext( src/core/hybridRetrievalEngine.ts:10: 
- PASS: DataAnalysis tool input availability - 434: normalizedRecords: snapshot.normalizedRecords, 435: validationResults: snapshot.validationResults, 436: projectContextSnapshots: snapshot.projectContextSnapshots, 461: normalizedRecords: snapshot.normalizedRecords, 462: validationResul
- PASS: WebFetch hardening markers - 645: const controller = new AbortController(); 665: const contentLength = Number(response.headers.get("content-length") ?? "0"); 667: throw new Error(`content-length exceeds 2MB for ${url}`); 683: const controller = new AbortController(); 7
- PASS: rawText sanitization markers - scripts\selftest.mjs:131: { label: "rawText sanitization markers", command: ["rg", "-n", "rawText", "scripts", "src/server", "src/core"], passWhen: (result) => result.exitCode === 0 }, scripts\selftest.mjs:334: let rawTextHits = 0; scripts\
- PASS: old previous-evidence WebFetch message removed

## 3. Server Smoke Test

- Health status: 200
- Health content type: `application/json; charset=utf-8`
- Health body: `{"ok":true,"mode":"web","dataRoot":"D:\\AI\\AetherOps\\.tmp\\aetherops-selftest","port":50226,"pid":12092,"startedAt":"2026-05-28T14:29:52.149Z","version":"0.1.0"}`
- settings.get summary:
  - LLM: `codex-oauth` / `gpt-5.5`
  - OpenCode: enabled=`true`, command=`opencode`
  - Embedding: provider=`openai`, apiKeyConfigured=`false`
  - Web Search: provider=`disabled`, apiKeyConfigured=`false`
  - Browser: enabled=`true`
- Legacy RPC default gate: PASS

## 4. Blocked-path E2E

- Status: `blocked`
- Project ID: `project_bd06beca-c5e8-4f04-8074-de2a591e7abc`
- Current step: `BUILD_VECTOR_INDEX`
- RuntimeBlockers: 1
- StepErrors: 1
- RunAuditOutputs: 1
- FinalOutputs: 0
- Bad evidence count: 0
- Latest blocker: `{"id":"blocker_c29f476d-78f6-4de4-965e-b23b05db4d2f","projectId":"project_bd06beca-c5e8-4f04-8074-de2a591e7abc","step":"BUILD_VECTOR_INDEX","requirementKey":"embedding.apiKey","message":"Embedding API key가 필요합니다.","createdAt":"2026-05-28T14:32:31.306Z"}`
- Counts: `{"sources":23,"evidence":3,"artifacts":10,"normalizedRecords":52,"chunks":0,"ontologyEntities":0,"ontologyRelations":0,"projectContextSnapshots":0,"validationResults":0}`

## 5. Live-path E2E

- Status: `SKIPPED`
- Reason: embedding
- Prerequisites: `{"llm":true,"openCode":true,"embedding":false,"externalSearch":true,"noMockFallback":true}`
- Counts: `{}`

## 6. File / DB Artifact Validation

- Required paths: PASS main/main.sqlite; PASS main/vector.sqlite; PASS main/ontology.sqlite; PASS main/files/sources; PASS projects
- rawText SQLite hits: 0
- Main source files: 10
- Project web source files: 0
- DB summaries: `[{"path":"aetherops.sqlite","counts":{"agent_plans":1,"artifacts":10,"benchmark_plans":1,"chunks":0,"continuation_decisions":0,"evidence":3,"final_outputs":0,"global_memory_items":0,"hybrid_contexts":0,"hypotheses":3,"iterations":11,"normalized_records":52,"ontology_constraints":0,"ontology_entities":0,"ontology_relations":0,"opencode_runs":1,"project_context_snapshots":0,"projects":1,"questions":1,"rag_contexts":0,"reports":0,"research_databases":1,"research_inputs":1,"research_plans":1,"research_specifications":1,"results":0,"run_audit_outputs":1,"runtime_blockers":1,"sessions":1,"sources":23,"step_errors":1,"tool_runs":4,"validation_results":0}},{"path":"main\\main.sqlite","counts":{"global_artifacts":10,"global_citations":0,"global_claims":0,"global_evidence":3,"global_memory_items":0,"global_normalized_records":52,"global_observations":0,"global_provenance":3,"global_sources":23,"global_tool_runs":4}},{"path":"main\\vector.sqlite","counts":{"global_chunks":0,"global_embeddings":0}},{"path":"main\\ontology.sqlite","counts":{"global_constraints":0,"global_entities":0,"global_relations":0}},{"path":"projects\\vector-rag-vs-hybrid-rag-테스트-2026-05-28\\project.sqlite","counts":{"agent_plans":0,"artifacts":10,"benchmark_plans":1,"continuation_decisions":0,"final_outputs":0,"hybrid_contexts":0,"normalized_records":0,"project_chunk_links":0,"project_constraint_links":0,"project_context_snapshots":0,"project_entity_links":0,"project_record_links":52,"project_relation_links":0,"reports":0,"research_inputs":1,"research_plans":1,"research_specifications":1,"run_audit_outputs":1,"runtime_blockers":0,"sources":23,"step_errors":0,"tool_runs":4,"validation_results":0}}]`

## 7. Security Tests

- Unsafe URL pre-fetch block: PASS
- Unsafe harness fetch calls: 0
- Public URL stub accepted: PASS
- Timeout/size/content-type coverage: covered by `npm test` and source invariant checks.

## 8. UTF-8 Test

- Korean blocked-path input preserved: PASS
- Audit markdown Korean preserved: PASS
- Contains `??`: NO
- Contains replacement char: NO
- API charset: `application/json; charset=utf-8`

Windows PowerShell note: use `Get-Content -Encoding UTF8 docs/aetherops-self-test-report.md` if the default console displays mojibake.

## 9. Findings

### Critical
- None.

### High
- None.

### Medium
- Live-path E2E skipped because real live provider prerequisites are missing.

### Low
- None.

## 10. Recommended Fixes

- No mandatory fixes. Configure real embedding/search credentials to exercise live-path E2E.

## 11. Verdict

`PASS_WITH_WARNINGS`
