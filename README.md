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
npm run ui:verify
npm run metadata:verify
npm run selftest
npm run selftest:blocked
npm run selftest:live
```

- `doctor`: Node 버전, scripts, data root, 포트, provider 설정, legacy RPC gate, production synthetic-substitute adapter 부재를 점검합니다.
- `ui:verify`: 실행 중인 실제 AetherOps UI(`AETHEROPS_UI_URL` 또는 기본 `http://127.0.0.1:5180`)에 Playwright로 접속해 `1920x1080`, `1440x900`, `1366x768`, `761px`, `760px`, `390x844`에서 sidebar 배치, settings 탭, Engineering request template 9개, SU2/OpenVSP template, 수평 overflow 부재를 검증합니다.
- `metadata:verify`: server build 후 실제 OpenAlex API를 호출해 `ResearchMetadataTool`이 DOI/URL이 있는 paper source와 citation/quote가 있는 evidence를 생성하는지 검증합니다. synthetic-substitute 없이 외부 네트워크를 사용합니다.
- `selftest`: 정적 검사, 빌드, 서버 verify, RPC, blocked-path E2E, DB/artifact/rawText, WebFetch 보안 verify, UTF-8 검증을 수행하고 `docs/aetherops-self-test-report.md`를 갱신합니다.
- `selftest:blocked`: live provider credential 없이도 deterministic blocked-path를 검증합니다.
- `selftest:live`: 실제 LLM/OpenCode/Embedding/Search 설정이 준비된 경우에만 live E2E를 수행합니다. credential이 부족하면 `SKIPPED`로 기록합니다. `node scripts/selftest.mjs --mode=live --strict-live`를 사용하면 prerequisites 누락을 exit 1로 처리합니다.

Verdict 기준:

- `FAIL`: typecheck/test/build/server/RPC 실패, legacy RPC gate 실패, production synthetic-substitute 발견, blocked-path에서 FinalOutput 생성, snippet/LLM claim의 support evidence 승격.
- `PASS_WITH_WARNINGS`: 핵심 검증은 통과했지만 live-path가 credential 부족으로 skipped되었거나 non-critical operational warning이 있는 경우.
- `PASS`: static, blocked-path, live-path, security, UTF-8 검증이 모두 통과한 경우.

## 주요 환경 변수

- `AETHEROPS_DATA_DIR`: 앱 데이터 루트. 기본값은 `.aetherops`.
- `AETHEROPS_PORT`: API 서버 포트. 기본값은 `5179`; `0`을 주면 OS가 빈 포트를 할당합니다.
- `AETHEROPS_ENABLE_LEGACY_RPC`: `true`일 때만 old RPC alias를 허용합니다. 기본값은 비활성입니다.
- `AETHEROPS_MARKDOWN_BOM`: markdown 보고서 앞에 UTF-8 BOM을 붙일지 제어합니다. `true`/`false`로 강제할 수 있으며, 지정하지 않으면 Windows에서는 PowerShell 호환을 위해 자동으로 켜지고 다른 OS에서는 꺼집니다.

Windows PowerShell에서 markdown, JSON, JSONL, NT 또는 source 파일의 한글이 깨져 보이면 다음처럼 UTF-8을 명시해 읽으세요. AetherOps의 source 파일과 생성 산출물은 UTF-8을 사용하며, markdown 보고서만 `AETHEROPS_MARKDOWN_BOM` 정책에 따라 BOM을 붙일 수 있습니다.

```powershell
Get-Content -Encoding UTF8 docs/aetherops-self-test-report.md
Get-Content -Encoding UTF8 .tmp/aetherops-selftest/blocked-path-result.json
Get-Content -Encoding UTF8 src/core/koreanCopy.test.ts
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
npm run doctor | Out-File -Encoding utf8 doctor-output.txt
```

PowerShell 5.1의 기본 `Get-Content`와 `>` 리다이렉션은 파일 bytes가 정상 UTF-8이어도 화면이나 출력 파일에서 한글을 깨뜨려 보일 수 있습니다. self-test는 generated text files를 byte-level strict UTF-8로 다시 읽어 이 차이를 보고서에 기록합니다.

## 연구 도구 통합 계약

AetherOps는 설정된 실제 도구만 `ResearchPlan.programRequests`로 실행합니다. synthetic-substitute 금지 정책에 따라 설정이 없거나 실행 인자가 불완전하면 seed/synthetic-substitute 결과를 만들지 않고 blocked 또는 failed로 남깁니다.

- `ResearchMetadataTool`: 실제 OpenAlex API에서 논문 metadata, DOI, 저자, abstract, citation count를 가져와 traceable source/evidence로 저장합니다.
- `EngineeringProgramTool`: `runtimeToolDiagnostics.engineeringProgramRequestTemplates`에서 `ready=true`인 template만 LLM 계획에 사용할 수 있습니다.
- 지원 template: `toolchain-check`, `mesh-inspect`, `xfoil-polar`, `openfoam-case-run`, `su2-case-run`(SU2), `cad-script-run`(FreeCAD), `vsp-script-run`(OpenVSP), `commercial-cfd-run`(FlightStream/STAR-CCM+ adapter).
- OpenFOAM은 command와 `system/controlDict`가 있는 case root가 필요합니다. SU2는 command, case root, case root 안의 `.cfg` config file, `{config}`가 포함된 args template가 필요합니다.
- FreeCAD/OpenVSP는 command, 기존 script path, `{script}`가 포함된 args template가 필요합니다. AetherOps는 누락된 script 또는 solver 인자를 추측하지 않습니다.
- FlightStream/STAR-CCM+는 라이선스가 있는 외부 adapter command와 명시적 args template가 준비된 경우에만 실행됩니다.
- OBJ/STL mesh inspection과 adapter input은 configured modeling artifact root 내부의 parser-valid artifact만 사용합니다.

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

- synthetic OpenCode adapter
- local research substitute adapter
- composite substitute chain
- Noop LLM 기반 자동 진행
- local/local-hash embedding substitute
- 설정 부족을 seed 또는 synthetic 결과로 조용히 대체하는 경로

필수 설정이 부족하면 프로젝트는 `blocked`로 기록됩니다. 실제 도구 실행이 실패하면 `failed`로 기록됩니다. 실패 전까지 생성된 partial output은 보존되며, blocked/failed 상태에서는 `RunAuditOutput`과 `reports/run-audit.md` / `exports/run-audit.json`이 생성될 수 있습니다. FinalOutput은 성공적인 최종화 조건에서만 생성됩니다.

## Live-test 준비 체크리스트

`npm run selftest:live`가 실제 live E2E를 수행하려면 다음이 필요합니다.

- Codex OAuth 또는 LLM API provider 사용 가능
- OpenCode command/path 사용 가능
- Embedding API key 설정
- Web Search provider/API key 또는 승인된 Browser runtime 설정
- `allowExternalSearch=true`
- production synthetic-substitute/local hash embedding 없음

credential이 없으면 live-path는 실패가 아니라 `SKIPPED`로 기록됩니다. 엄격한 CI에서 credential 누락을 실패로 보고 싶으면 `node scripts/selftest.mjs --mode=live --strict-live`를 사용하세요.

## CI and self-test operation

GitHub Actions runs `.github/workflows/ci.yml` on every `push` and `pull_request`.
The default QA job uses Node.js 22 and runs the required gate in this order:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run selftest:blocked
```

The CI job uploads the generated `docs/aetherops-self-test-report.md` report plus
key `.tmp/aetherops-selftest` JSON, JSONL, Markdown, SQLite, and blocked-path
artifacts. These artifacts are the evidence bundle to inspect when a CI run fails
or when a blocked-path run needs auditing.

Manual live testing is available from `workflow_dispatch`. Set `run_live=true` to
start the live job. The live job is never started by normal push or pull request
events. It runs:

```bash
npm run selftest:live -- --full-static
```

Set `strict_live=true` as well when missing live prerequisites should fail the
manual job. The workflow then appends `--strict-live`:

```bash
npm run selftest:live -- --full-static --strict-live
```

`selftest:live` normally exercises the live path only when real LLM/OpenCode,
embedding, and search/browser prerequisites are configured. If credentials or
provider settings are missing, the live path is recorded as `SKIPPED`; this is
not a hard failure unless `--strict-live` is used.

Useful self-test flags:

- `--full-static`: in live mode, run typecheck, tests, and build before live E2E.
- `--skip-static`: skip static checks when you only need the runtime path.
- `--strict-live`: make missing live prerequisites fail live mode instead of
  reporting a skipped live path.

`PASS_WITH_WARNINGS` means mandatory static, blocked-path, artifact, security,
and UTF-8 checks passed, but the report contains a non-critical operational
warning. The common case is live E2E being skipped because credentials are not
available in the current environment.

The generated report includes an `Evidence Policy Table`. That table explains
which records are allowed to support a hypothesis: source-backed evidence needs
traceability such as `sourceUri`, citation, quote/span, and quality metadata.
Search snippets, unsupported claims, and internal artifacts without source-backed
provenance can be useful context, but they do not count as hypothesis-supporting
evidence.

On Windows PowerShell, use explicit UTF-8 when reading generated Markdown, JSON,
JSONL, NT, or source files if the console shows mojibake:

```powershell
Get-Content -Encoding UTF8 docs/aetherops-self-test-report.md
Get-Content -Encoding UTF8 .tmp/aetherops-selftest/blocked-path-result.json
Get-Content -Encoding UTF8 src/core/koreanCopy.test.ts
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
npm run doctor | Out-File -Encoding utf8 doctor-output.txt
```

PowerShell 5.1 can display or redirect mojibake even when the file bytes are valid UTF-8. The self-test report records strict byte-level UTF-8 decode results for generated text artifacts so this can be distinguished from real data corruption.
