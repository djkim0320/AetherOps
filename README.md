# AetherOps

AetherOps는 프로젝트 기반 자율 연구 에이전트입니다. 연구 질문과 가설을 검증 가능한 연구 명세로 바꾸고, OpenCode 도구 호출과 내장 브라우저 도구를 통해 자료를 수집한 뒤, 정규화된 근거를 Vector Index와 Ontology Graph에 적재해 검증과 최종 보고서 생성을 수행합니다.

현재 구조는 Electron을 제거한 `React + TypeScript` 웹 프론트엔드와 로컬 `Node.js` HTTP 백엔드로 동작합니다.

## 12단계 연구 아키텍처

1. 연구 DB 생성
2. 연구 질문 및 가설 입력
3. 연구 명세 수립 / 가설 및 검증 전략
4. 연구 계획 수립
5. 도구 실행 및 연구 수행
6. 데이터 수집 및 정규화
7. 임베딩 및 벡터 구조화 / Vector Index
8. 온톨로지 기반 구조화 / Knowledge Graph
9. 추론 및 검증
10. 결과 합성 및 가설 평가
11. 계속 연구 여부 판단
12. 최종 결과 도출

11단계에서 근거가 부족하거나 추가 분석이 필요하면 바로 도구 실행으로 가지 않습니다. 반드시 4단계 연구 계획 수립으로 돌아가 다음 iteration의 `ResearchPlan`을 갱신한 뒤 5단계로 진행합니다. 충분한 결론에 도달했거나 반복 예산이 끝나면 12단계 최종 결과 도출로 이동합니다.

## 핵심 개념

- **Evidence Ledger**: Source, Artifact, Claim, Evidence, Observation, Citation을 보관하는 연구 근거 장부입니다.
- **Vector Index**: 정규화된 source, artifact, evidence, observation, citation을 chunk와 embedding으로 색인하는 검색 인덱스입니다.
- **Ontology Graph**: 질문, 가설, 주장, 근거, 출처, 도구, 제약, 한계, 결과의 개념과 관계를 구조화한 지식 그래프입니다.
- **Hybrid Retrieval**: Vector Search와 Graph Search를 결합해 `HybridContext`를 구성합니다.
- **Persistent Research Memory**: Raw Sources, Artifacts, Tool Logs, Evidence Ledger, Vector DB, Ontology Graph DB, Projects, Reports, Exports를 프로젝트별로 보존합니다.

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
  state.json
```

최종 산출물은 다음 파일로 저장됩니다.

- `reports/final-report.md`
- `knowledge/reusable-knowledge.md`
- `exports/evidence-citations.json`
- `exports/hypothesis-verification.json`
- `ontology/project-graph.json`
- `ontology/project-graph.nt`
- `exports/artifact-package.json`

## OpenCode 통합 정책

AetherOps는 공식 OpenCode CLI를 실행 엔진으로 사용합니다. `opencode-ai`를 dependency로 동봉하며, 설정된 command/path가 없으면 `node_modules/opencode-ai/bin/opencode.exe` 또는 `node_modules/.bin/opencode`를 우선 탐색합니다.

운영 경로에서는 `RealOpenCodeAdapter`만 사용합니다. 별도의 로컬 연구 실행기나 모의 실행기는 사용하지 않습니다. OpenCode CLI가 없거나 인증, provider, model 설정이 잘못되면 연구 루프를 다른 실행기로 이어가지 않고 실패 상태로 멈추며, `tool_unavailable` 및 `evidence_gap` 기록을 남깁니다.

OpenCode 인증은 OpenCode의 공식 auth/provider 설정을 따릅니다. 설정 화면의 OpenCode OAuth 버튼은 로컬 OpenCode CLI로 `opencode auth login`을 실행합니다.

## 내장 Chromium 브라우저 도구

AetherOps는 로컬 백엔드 안에서 Playwright 기반 Chromium을 별도 사용자 프로필로 실행할 수 있습니다. 이 기능은 사용자의 일반 Chrome 창을 제어하지 않고, 백그라운드 브라우저에서 검색 결과와 웹 페이지 본문을 수집합니다.

브라우저 도구는 설정의 `browserUse.enabled`가 켜져 있고 프로젝트의 `allowExternalSearch`가 허용될 때만 동작합니다.

- 검색 쿼리 생성
- DuckDuckGo HTML 검색
- 검색 결과 URL 정규화
- 페이지 본문 추출
- `ResearchSource`, `ResearchArtifact`, `EvidenceItem`, `ToolRun` 저장
- 이후 `NormalizedResearchRecord`, Vector Index, Ontology Graph, Hybrid Retrieval로 연결

브라우저 수집이 실패하면 실제 근거처럼 꾸미지 않고 `Background browser evidence_gap`으로 기록합니다.

## 검증된 연구 실행 예시

Playwright로 실제 웹앱을 조작해 다음 주제의 2회 반복 연구 루프를 확인했습니다.

> 대학생 소프트웨어 팀 프로젝트에서 AI 코딩 도구 사용이 코드 리뷰 품질, 개발 속도, 학습 효과에 미치는 영향

확인된 최종 상태:

- 상태: `completed`
- 최종 단계: `FINALIZE_OUTPUTS`
- OpenCode run: 2회
- BackgroundBrowserTool: 1회 실패 기록 후 1회 성공
- Raw Sources: 38
- Evidence: 17
- Artifacts: 24
- Normalized Records: 108
- Vector Chunks: 140
- Ontology Graph: entity 639 / relation 2189
- Validation Results: 4
- Final Output: 1

이 검증에서 최종 보고서, 재사용 지식 자산, citation 목록, ontology graph export가 프로젝트 폴더에 생성되는 것을 확인했습니다.

검증 시점: 2026-05-21 12:21 KST

검증 명령:

```bash
npm run typecheck
npm test
npm run build
```

수동 검증은 Playwright headless 브라우저로 웹앱을 열어 프로젝트 생성, 관제 화면 진입, 연구 루프 시작, 최종 대시보드 확인 순서로 수행했습니다.

## 개발 실행

```bash
npm install
npm run dev
```

개발 모드는 다음 두 프로세스를 함께 실행합니다.

- 백엔드: `http://127.0.0.1:5179`
- 프론트엔드: `http://127.0.0.1:5180`

## 프로덕션 빌드 및 실행

```bash
npm run typecheck
npm test
npm run build
npm run start
```

빌드 후 `npm run start`를 실행하면 백엔드가 `dist/` 프론트엔드 정적 파일을 함께 제공합니다.

Windows에서는 아래 파일로도 실행할 수 있습니다.

```bat
run-aetherops.bat
```

## HTTP API 호환성

프론트엔드는 `POST /api/rpc`를 사용합니다. 기존 RPC method 이름은 호환 목적으로 유지됩니다.

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
