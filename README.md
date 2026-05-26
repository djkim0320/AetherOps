# AetherOps

AetherOps는 연구 질문과 가설을 입력받아 도구 실행, 자료 정규화, 벡터 인덱싱, 온톨로지 그래프, 검증, 최종 보고서 생성을 수행하는 웹 기반 자율 연구 에이전트입니다.

현재 런타임은 `React + TypeScript` 프론트엔드와 `Node.js` HTTP 서버로 동작합니다. Electron legacy 런타임은 사용하지 않습니다.

## 요구 환경

- Node.js `>=22.16.0`
- npm
- 실제 연구 실행용 설정
  - LLM: Codex OAuth 또는 API provider
  - OpenCode command/path
  - Embedding provider/model/API key
  - 외부 검색을 사용하는 경우 Web Search 또는 Background Browser 설정

`node:sqlite`의 `DatabaseSync`를 사용하므로 Node 22 최신 버전을 권장합니다.

## 12단계 연구 검증 루프

### 연구 설계

1. 연구 DB 생성
2. 연구 질문 및 가설 입력
3. 연구 명세 수립 / 가설 및 검증 전략
4. 연구 계획 수립

### 반복 연구 실행 및 분석

5. 도구 실행 및 연구 수행
6. 데이터 수집 및 정규화
7. 임베딩 및 벡터 구조화 / Vector Index
8. 온톨로지 기반 구조화 / Knowledge Graph
9. 추론 및 검증
10. 결과 합성 및 가설 평가

### 루프 판단과 최종 산출

11. 계속 연구 여부 판단
12. 최종 결과 도출

11단계에서 `shouldContinue=true`이면 5단계로 바로 돌아가지 않습니다. 반드시 4단계 연구 계획 수립으로 복귀해 다음 `ResearchPlan`을 갱신한 뒤 새 iteration의 5단계로 진행합니다. `shouldContinue=false`이면 12단계에서 최종 보고서와 재사용 가능한 지식 자산을 생성합니다.

반복 횟수는 사용자가 지정하지 않습니다. 에이전트가 11단계 판단에서 근거 충분성, 검증 상태, evidence gap, 예산/시간 제약, 내부 안전 상한을 보고 자율적으로 결정합니다.

## Main Research Memory DB + Project Workspace DB

AetherOps는 장기 기억과 프로젝트 작업공간을 분리합니다.

### Main Research Memory

전역 장기 연구 기억입니다. 여러 프로젝트에서 재사용 가능한 원천 자료, 정규화 record, vector chunk, ontology graph, 검증된 지식 자산을 보관합니다.

```text
.aetherops/main/
  main.sqlite
  vector.sqlite
  ontology.sqlite
  files/
    sources/
    artifacts/
    logs/
```

주요 logical collection:

- `global_sources`
- `global_artifacts`
- `global_normalized_records`
- `global_chunks`
- `global_entities`
- `global_relations`
- `global_constraints`
- `global_tool_runs`
- `global_provenance`
- `global_memory_items`

### Project Workspace

프로젝트별 연구 입력, 명세, 계획, 선택된 context, 검증 결과, 최종 산출물만 저장합니다. Main DB의 raw source/evidence/artifact 원문을 무조건 복사하지 않고 ID reference와 context snapshot을 저장합니다.

```text
.aetherops/projects/{project-id}/
  project.sqlite
  context/
  reports/
  knowledge/
  exports/
  logs/
```

주요 저장 대상:

- `research_inputs`
- `research_specifications`
- `research_plans`
- `project_record_links`
- `project_context_snapshots`
- `validation_results`
- `continuation_decisions`
- `final_outputs`

## 6~10단계 데이터 흐름

- **6. 데이터 수집 및 정규화**: `Source`, `Artifact`, `Claim`, `Evidence`, `Observation`, `Citation`, `Error` 단위로 정규화합니다. 재사용 가능한 외부 source는 Main DB에 저장하고, 프로젝트는 record link만 가집니다.
- **7. 임베딩 및 벡터 구조화**: 현재 프로젝트와 연결된 Main normalized record 중 색인 가능한 항목만 Main Vector Index에 저장합니다. `error`, `ephemeral`, runtime blocker, step error는 색인하지 않습니다.
- **8. 온톨로지 기반 구조화**: Main normalized record에서 entity/relation/constraint를 추출해 Main Ontology Graph에 저장합니다. `sourceRecordId` 또는 `sourceEvidenceId` 없는 triple은 저장하지 않습니다.
- **9. 추론 및 검증**: `ProjectContextBuilder`가 Main DB, Vector Index, Ontology Graph에서 현재 연구 계획에 필요한 자료를 선택해 `ProjectContextSnapshot`을 만듭니다. 이 snapshot 없이는 추론/검증을 실행하지 않습니다.
- **10. 결과 합성 및 가설 평가**: `ProjectContextSnapshot`과 `ValidationResult`를 기반으로 deterministic draft를 만들고, LLM은 citation-preserving 정리만 수행합니다. citation이나 validation 연결이 누락되면 실패로 기록합니다.

## Evidence 정책

- 검색 snippet은 evidence가 아닙니다. `WebSearchTool`은 source 후보와 claim/observation만 생성합니다.
- `WebFetchTool`이 실제 본문을 가져오고 quote/citation/sourceUri가 있을 때만 evidence로 승격할 수 있습니다.
- `internal_artifact`와 `project://...` provenance는 context에는 들어갈 수 있지만 가설을 지지하는 evidence로 쓰지 않습니다.
- citation/sourceUri 없는 claim은 hypothesis support evidence가 될 수 없습니다.

## 메모리 승격

최종 결과 이후 `MemoryPromotionEngine`이 검증된 지식만 Main DB의 `global_memory_items`로 승격합니다.

승격 조건:

- validation status가 `supported` 또는 `contradicted`
- citation/provenance가 충분함
- 관련 normalized record가 `validationStatus="validated"`

승격 금지:

- `inconclusive`
- `not_tested`
- internal artifact 기반 claim
- citation 없는 claim

## 실패 정책

production runtime에서는 다음 대체 실행을 사용하지 않습니다.

- mock OpenCode adapter
- local research fallback adapter
- composite fallback chain
- Noop LLM 기반 자동 진행
- local hash embedding fallback
- 검색 실패나 evidence gap만으로 연구를 조용히 계속 진행하는 경로

필수 설정이 부족하면 프로젝트는 `blocked`가 됩니다. 실제 도구 실행 실패는 `failed`로 기록됩니다. 원인은 UI의 Errors / Blockers 영역과 프로젝트의 `logs/` 및 `errors/` 파일에서 확인할 수 있습니다.

## 실행

```bash
npm install
npm run dev
```

기본 주소:

- API 서버: `http://127.0.0.1:5179`
- Vite 프론트엔드: `http://127.0.0.1:5180`

프로덕션 빌드:

```bash
npm run build
npm run start
```

검증:

```bash
npm run typecheck
npm test
npm run build
```
