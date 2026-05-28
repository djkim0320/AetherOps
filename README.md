# AetherOps

AetherOps는 TypeScript / React / Node.js 기반의 자율 연구 에이전트 웹앱입니다. 연구 질문과 가설을 입력하면 12단계 연구 검증 루프를 통해 도구 실행, 데이터 정규화, Vector Index, Ontology Graph, 검증, 합성, 최종 산출을 수행합니다.

현재 런타임은 웹앱 구조입니다. Electron legacy runtime은 production 경로로 사용하지 않습니다.

## 요구 환경

- Node.js `>=22.16.0`
- npm
- 실제 연구 실행에 필요한 설정
  - LLM: Codex OAuth 또는 API provider
  - OpenCode command/path
  - Embedding provider/model/API key
  - 외부 검색을 사용할 경우 Web Search provider/API key 또는 승인된 Browser runtime

`node:sqlite`의 `DatabaseSync`를 사용하므로 Node 22 최신 LTS/Current 계열을 권장합니다.

## 실행

```bash
npm install
npm run dev
```

기본 주소:

- API 서버: `http://127.0.0.1:5179`
- Vite 프론트엔드: `http://127.0.0.1:5180`

프로덕션 빌드 실행:

```bash
npm run build
npm run start
```

## 공식 검증 명령

```bash
npm run doctor
npm run selftest
npm run selftest:blocked
npm run selftest:live
```

- `doctor`: Node 버전, scripts, data root, 포트, provider 설정, legacy RPC gate, production mock/fallback adapter 부재를 점검합니다.
- `selftest`: 정적 검사, 빌드, 서버 smoke, RPC, blocked-path E2E, DB/artifact/rawText, WebFetch 보안 smoke, UTF-8 검증을 수행하고 `docs/aetherops-self-test-report.md`를 갱신합니다.
- `selftest:blocked`: live provider credential 없이도 deterministic blocked-path를 검증합니다.
- `selftest:live`: 실제 LLM/OpenCode/Embedding/Search 설정이 준비된 경우에만 live E2E를 수행합니다. credential이 부족하면 `SKIPPED`로 기록합니다. `node scripts/selftest.mjs --mode=live --strict-live`를 사용하면 prerequisites 누락을 exit 1로 처리합니다.

Verdict 기준:

- `FAIL`: typecheck/test/build/server/RPC 실패, legacy RPC gate 실패, production mock/fallback 발견, blocked-path에서 FinalOutput 생성, snippet/LLM claim의 support evidence 승격.
- `PASS_WITH_WARNINGS`: 핵심 검증은 통과했지만 live-path가 credential 부족으로 skipped되었거나 non-critical operational warning이 있는 경우.
- `PASS`: static, blocked-path, live-path, security, UTF-8 검증이 모두 통과한 경우.

## 주요 환경 변수

- `AETHEROPS_DATA_DIR`: 앱 데이터 루트. 기본값은 `.aetherops`.
- `AETHEROPS_PORT`: API 서버 포트. 기본값은 `5179`; `0`을 주면 OS가 빈 포트를 할당합니다.
- `AETHEROPS_ENABLE_LEGACY_RPC`: `true`일 때만 old RPC alias를 허용합니다. 기본값은 비활성입니다.
- `AETHEROPS_MARKDOWN_BOM`: `true`일 때 self-test markdown report 앞에 UTF-8 BOM을 붙입니다. 기본값은 `false`.

Windows PowerShell에서 markdown 한글이 깨져 보이면 다음처럼 UTF-8을 명시해 읽으세요.

```powershell
Get-Content -Encoding UTF8 docs/aetherops-self-test-report.md
```

## 12단계 연구 검증 루프

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

11단계에서 `shouldContinue=true`이면 5단계로 직접 돌아가지 않습니다. 반드시 4단계 연구 계획 수립으로 복귀해 `ResearchPlan`을 갱신한 뒤 다음 iteration의 도구 실행으로 진행합니다.

## Main Research Memory + Project Workspace

AetherOps는 장기 기억과 프로젝트 작업공간을 분리합니다.

```text
.aetherops/main/
  main.sqlite
  vector.sqlite
  ontology.sqlite
  files/
    sources/
    artifacts/
    logs/

.aetherops/projects/{project-id}/
  project.sqlite
  context/
  reports/
  knowledge/
  exports/
  logs/
  artifacts/
```

외부 raw source는 Main Research Memory의 `main/files/sources`에 canonical file로 저장합니다. Project Workspace에는 source/record/context id 링크와 연구별 산출물만 저장합니다. 내부 생성 artifact는 프로젝트 workspace에 남을 수 있지만, 가설 지지 evidence로 사용하지 않습니다.

## Evidence 정책

- 검색 snippet은 evidence가 아닙니다. `WebSearchTool`은 source candidate만 생성합니다.
- `WebFetchTool` 또는 PDF ingestion이 실제 본문을 확인하고 `sourceUri`, `citation`, `quote/span`을 가진 경우에만 evidence로 승격할 수 있습니다.
- citation/sourceUri/quote/span 없는 claim은 evidence가 아니라 claim 또는 observation입니다.
- internal artifact와 `project://...` provenance는 context에는 들어갈 수 있지만 hypothesis support evidence가 될 수 없습니다.
- 9단계 추론/검증과 10단계 합성은 `ProjectContextSnapshot` 없이 실행되지 않습니다.

## 실패 정책

production runtime에서는 다음을 사용하지 않습니다.

- mock OpenCode adapter
- local research fallback adapter
- composite fallback chain
- Noop LLM 기반 자동 진행
- local/local-hash embedding fallback
- 설정 부족을 seed/mock 결과로 조용히 대체하는 경로

필수 설정이 부족하면 프로젝트는 `blocked`로 기록됩니다. 실제 도구 실행이 실패하면 `failed`로 기록됩니다. 실패 전까지 생성된 partial output은 보존되며, blocked/failed 상태에서는 `RunAuditOutput`과 `reports/run-audit.md` / `exports/run-audit.json`이 생성될 수 있습니다. FinalOutput은 성공적인 최종화 조건에서만 생성됩니다.

## Live-test 준비 체크리스트

`npm run selftest:live`가 실제 live E2E를 수행하려면 다음이 필요합니다.

- Codex OAuth 또는 LLM API provider 사용 가능
- OpenCode command/path 사용 가능
- Embedding API key 설정
- Web Search provider/API key 또는 승인된 Browser runtime 설정
- `allowExternalSearch=true`
- production mock/fallback/local hash embedding 없음

credential이 없으면 live-path는 실패가 아니라 `SKIPPED`로 기록됩니다. 엄격한 CI에서 credential 누락을 실패로 보고 싶으면 `node scripts/selftest.mjs --mode=live --strict-live`를 사용하세요.
