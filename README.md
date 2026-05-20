# AetherOps

AetherOps는 프로젝트 기반 자율 연구 에이전트 웹앱입니다. 사용자의 연구 질문과 가설을 검증 가능한 연구 명세로 바꾸고, OpenCode 실행, 자료 정규화, Vector RAG, Ontology Graph, 검증, 최종 보고서 생성을 하나의 연구 루프로 연결합니다.

현재 구조는 `React + TypeScript` 프론트엔드와 로컬 `Node.js` HTTP 백엔드로 동작합니다.

## 12단계 연구 아키텍처

1. 연구 DB 생성
2. 연구 질문 및 가설 입력
3. 연구 명세 수립 / 가설 및 검증 전략
4. 연구 계획 수립
5. 도구 실행 및 연구 수행
6. 데이터 수집 및 정규화
7. 임베딩 및 벡터 구조화 / Vector Index
8. 온톨로지 기반 구조화 / 지식 그래프
9. 추론 및 검증
10. 결과 합성 및 가설 평가
11. 계속 연구 여부 판단
12. 최종 결과 도출

11단계에서 근거가 부족하거나 추가 분석이 필요하면 바로 도구 실행으로 가지 않고 4단계 연구 계획 수립으로 돌아가 다음 iteration 계획을 갱신합니다. 충분한 결론이 나오거나 반복 예산이 끝나면 12단계로 이동합니다.

## 핵심 개념

- **Evidence Ledger**: 근거, 근거 부족, 도구 사용 불가, citation, 한계를 추적하는 연구 장부입니다.
- **Vector RAG**: 정규화된 source, artifact, evidence, observation, citation을 chunk/embedding으로 색인하는 검색 인덱스입니다.
- **Ontology Graph**: 질문, 가설, 주장, 근거, 출처, 도구, 지표, 제약, 한계, 결과의 개념과 관계를 구조화합니다.
- **Hybrid Retrieval**: Vector Search와 Graph Search를 통합해 `HybridContext`를 구성합니다.
- **Persistent Research Memory**: Raw Sources, Artifacts, Tool Logs, Evidence Ledger, Vector DB, Ontology Graph DB, Projects, Reports, Exports를 프로젝트별로 보존합니다.

## 로컬 프로젝트 저장소

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
- `reports/evidence-citations.json`
- `reports/hypothesis-verification.json`
- `ontology/project-graph.json`
- `ontology/project-graph.nt`
- `exports/artifact-package.json`

## OpenCode 통합

AetherOps는 `opencode-ai`를 dependency로 동봉합니다. 기본 설정의 `opencode` 명령이 전역 PATH에 없으면 `node_modules/opencode-ai/bin/opencode.exe` 또는 `node_modules/.bin/opencode`를 우선 사용합니다.

Mock 또는 local fallback 연구 실행은 production 연구 루프에서 사용하지 않습니다. OpenCode CLI가 없거나 인증/provider/model 설정이 잘못되면 연구 루프는 명확한 오류와 `failed` 상태를 남기고, 가짜 근거를 생성하지 않습니다.

OpenCode 인증은 OpenCode 공식 auth/provider 설정을 따릅니다. 설정 화면의 OpenCode OAuth 버튼은 동봉된 OpenCode CLI로 `opencode auth login`을 실행합니다.

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

빌드 후 `npm run start`를 실행하면 백엔드가 `dist/` 프론트엔드 정적 파일을 함께 서빙합니다.

Windows에서는 아래 파일을 실행해도 됩니다.

```bat
run-aetherops.bat
```

## HTTP API 호환성

웹 프론트엔드는 `POST /api/rpc`를 사용합니다. 기존 호출 이름은 RPC method로 유지됩니다.

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
