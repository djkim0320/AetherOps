# AetherOps

AetherOps는 프로젝트 기반 자율 연구 에이전트 웹앱입니다. 연구 질문과 가설을 명시 입력으로 받고, 검증 가능한 연구 명세와 연구 계획으로 바꾼 뒤, 실제로 설정된 실행 도구와 근거 저장소를 사용해 연구를 진행합니다.

현재 구조는 Electron을 제거한 `React + TypeScript` 프론트엔드와 로컬 `Node.js` HTTP 서버입니다. 운영 경로에서는 mock adapter, local fallback, silent seed, 로컬 해시 임베딩 대체 경로를 사용하지 않습니다. 필수 설정이 없으면 다음 단계로 조용히 넘어가지 않고 프로젝트를 `blocked` 상태로 멈추며 `RuntimeBlocker`와 `StepError`를 기록합니다.

## 12단계 연구 검증 아키텍처

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

11단계에서 `shouldContinue=true`이면 5단계로 바로 돌아가지 않습니다. 반드시 4단계 연구 계획 수립으로 복귀해 다음 iteration의 `ResearchPlan`을 갱신한 뒤 5단계로 진행합니다. `shouldContinue=false`이면 12단계에서 최종 보고서와 재사용 가능한 지식 자산을 생성합니다.

## 핵심 개념

- **Evidence Ledger**: Source, Artifact, Claim, Evidence, Observation, Citation, Error를 보관하는 연구 근거 장부입니다.
- **Vector Index**: 6단계에서 정규화된 레코드를 chunk와 embedding으로 구조화하는 검색 인덱스입니다.
- **Ontology Graph**: 질문, 가설, 주장, 근거, 출처, 도구, 제약, 한계, 결과의 관계를 저장하는 지식 그래프입니다.
- **Hybrid Retrieval**: Vector Search와 Graph Search를 결합해 `HybridContext`를 구성합니다.
- **Persistent Research Memory**: Raw Sources, Artifacts, Tool Logs, Evidence Ledger, Vector DB, Ontology Graph DB, Projects & Reports, Errors & Blockers를 프로젝트별로 보존합니다.

Vector Index와 Ontology Graph는 둘 다 6단계 정규화 데이터에서 만들어지는 병렬 지식화 단계입니다. Ontology Graph는 Vector RAG 뒤에 종속되지 않습니다.

## 엄격한 런타임 정책

운영 코드에서는 다음 대체 실행을 사용하지 않습니다.

- Mock OpenCode adapter
- Local research fallback adapter
- Composite fallback adapter chain
- Noop LLM 기반 자동 진행
- 로컬 해시 임베딩 대체 경로
- `skipped` 결과나 `evidence_gap`만으로 연구를 계속 진행하는 경로

필수 조건이 부족하면 앱 프로세스를 crash시키지 않고 프로젝트 상태를 `blocked`로 저장합니다. 실제 실행 도구가 실패하면 프로젝트 상태를 `failed`로 저장합니다. 두 경우 모두 UI의 오류/Blocker 패널과 프로젝트 저장소의 `errors/` 로그에서 원인을 확인할 수 있습니다.

## 필수 설정

단계별 필수 설정은 다음과 같습니다.

- 2단계: 사용자가 명시 입력한 연구 질문과 초기 가설
- 3, 4, 10단계: 사용 가능한 LLM 설정
- 5단계: OpenCode command/path와 연구 계획이 요구하는 실제 도구 설정
- 7단계: 실제 embedding provider, model, API key
- 8단계: 실행 가능한 ontology extraction mode
- 12단계: 프로젝트 저장소 쓰기 가능 상태

외부 검색이 꺼진 연구 계획에서는 Web Search 설정을 요구하지 않습니다. 코드 실행이 꺼진 연구 계획에서는 CodeExecutionTool을 요구하지 않습니다.

## 프로젝트 저장소

각 프로젝트는 아래 구조로 격리 저장됩니다.

```text
.aetherops/projects/{project-slug}/
  research.sqlite
  vector.sqlite
  ontology.sqlite
  sources/
  artifacts/
  logs/
  reports/
  knowledge/
  ontology/
  exports/
  errors/
  state.json
```

최종 산출과 오류 로그는 다음 파일로 저장됩니다.

- `reports/final-report.md`
- `knowledge/reusable-knowledge.md`
- `exports/evidence-citations.json`
- `exports/hypothesis-verification.json`
- `ontology/project-graph.json`
- `ontology/project-graph.nt`
- `exports/artifact-package.json`
- `errors/step-errors.jsonl`
- `errors/runtime-blockers.jsonl`

## OpenCode 통합

AetherOps는 공식 OpenCode CLI를 도구 실행 엔진으로 사용합니다. 설정한 `openCode.command` 또는 명시적으로 동봉된 공식 binary만 사용하며, 임의 시스템 경로를 조용히 탐색해 대체하지 않습니다.

OpenCode 인증은 OpenCode의 공식 auth/provider 설정을 따릅니다. AetherOps 설정 화면의 OpenCode OAuth 버튼은 로컬 CLI의 `opencode auth login` 흐름을 실행하기 위한 편의 기능입니다.

## 내장 Chromium 브라우저 도구

내장 Chromium 브라우저 도구는 별도 사용자 프로필로 백그라운드에서 실행됩니다. 사용자의 일반 Chrome 창을 제어하지 않습니다.

이 도구는 `browserUse.enabled=true`, 프로젝트와 앱 설정의 `allowExternalSearch=true`, 그리고 연구 계획의 requiredTools에 브라우저 도구가 포함된 경우에만 실행됩니다. 조건이 충족되지 않으면 대체 검색으로 넘어가지 않고 해당 단계가 `blocked` 또는 `failed`로 기록됩니다.

## 개발 실행

```bash
npm install
npm run dev
```

개발 서버는 기본적으로 다음 주소를 사용합니다.

- API 서버: `http://127.0.0.1:5179`
- Vite 프론트엔드: `http://127.0.0.1:5180`

## 프로덕션 빌드와 실행

```bash
npm run typecheck
npm test
npm run build
npm run start
```

Windows에서는 `run-aetherops.bat`로도 실행할 수 있습니다.

## RPC 호환성

기존 RPC 이름은 UI 호환을 위해 유지합니다.

- `projects.create`
- `sessions.createForProject`
- `researchDb.create`
- `research.seedQuestions`
- `loop.start`
- `loop.pause`
- `loop.resume`
- `loop.abort`
- `opencode.run`
- `rag.buildContext`
- `results.derive`
- `reports.finalize`

12단계 alias도 사용할 수 있습니다.

- `aetherops:createResearchDb`
- `aetherops:inputResearchQuestionHypothesis`
- `aetherops:buildResearchSpecification`
- `aetherops:planResearch`
- `aetherops:startLoop`
- `aetherops:pause`
- `aetherops:resume`
- `aetherops:abort`
- `aetherops:getSnapshot`
- `aetherops:getSettings`
- `aetherops:updateSettings`
