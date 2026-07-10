# AetherOps

AetherOps는 React, Node.js, SQLite로 구성된 로컬 단일 사용자 연구 에이전트입니다. 프로젝트별 채팅을 시작점으로 연구 계획, 도구 실행, 근거 정규화, 검색 인덱스와 온톨로지 구축, 검증, 최종 산출물 생성을 수행합니다.

## 요구 환경

- Node.js `>=22.16.0 <23`
- npm과 추적된 `package-lock.json`
- Orchestrator LLM용 Codex OAuth
- 선택 기능에 필요한 실제 provider 또는 engineering 실행 파일

Embedding과 Web Search provider는 Codex 설정과 독립적입니다. 준비되지 않은 기능은 synthetic 결과로 대체하지 않고 `blocked` 또는 `failed`로 기록합니다.

## 설치와 실행

```bash
npm ci
npm run dev
```

기본 서버 주소는 `http://127.0.0.1:5179`입니다. Production 빌드는 다음과 같이 실행합니다.

```bash
npm run build
npm run start
```

## 데이터와 마이그레이션

기본 데이터 루트는 `.aetherops`이며 `AETHEROPS_DATA_DIR`로 변경할 수 있습니다. 서버는 HTTP listen 전에 필수 migration을 확인합니다.

```bash
npm run migrate:check
npm run migrate:apply
npm run migrate:verify
npm run migrate:rollback
```

`check`와 `verify`는 read-only입니다. 기존 데이터는 backup manifest와 SHA-256 검증을 거쳐 v2로 이동하며, 검증되지 않은 downgrade는 수행하지 않습니다.

## 공개 인터페이스

- RPC: `POST /api/v2/rpc`
- SSE: `GET /api/v2/events?projectId=<id>`
- Health: `GET /api/health`

RPC는 named `params`만 사용합니다. Renderer의 서버 상태는 TanStack Query가 소유하고 SSE는 cache patch 또는 invalidate만 수행합니다. Polling fallback은 없습니다.

## Codex 설정

기본 설정은 `gpt-5.6 / xhigh / 180000ms`입니다. 모델, reasoning effort, timeout은 호출마다 영속 설정에서 다시 읽습니다. 계정 entitlement 오류가 발생해도 다른 모델로 fallback하지 않습니다.

OpenCode는 engineering 실행 경로이며 Codex Orchestrator 설정과 별도로 유지됩니다.

## 검증 명령

```bash
npm run lint
npm run format:check
npm run typecheck
npm run architecture:check
npm run size:check
npm run stylelint
npm run css:tokens
npm test
npm run build
npm run doctor
npm run selftest:blocked
```

- `ui:verify`: 실제 실행 중인 서버를 Playwright로 검사합니다. 지원 viewport, dark/light theme, inspector deep-link, console 오류와 axe serious/critical 위반을 확인합니다.
- `metadata:verify`: 실제 OpenAlex를 사용하는 manual/nightly 검증입니다.
- `selftest:blocked`: 외부 credential 없이 fail-closed 경로를 검증합니다.
- `selftest:live`: 실제 Codex, Embedding, Search/Browser 및 engineering prerequisite가 준비된 환경에서만 실행합니다.

Live 검증은 일반 offline CI에 포함하지 않습니다. 필수 prerequisite가 없으면 `SKIPPED`이며, 누락을 실패로 처리하려면 `--strict-live`를 사용합니다.

## UI 지원 범위

공식 지원 범위는 `1280×720` 이상 데스크톱입니다. 기본 화면은 프로젝트별 chat이며 Run, Evidence, Artifacts는 inspector에서 확인합니다. 원격 폰트와 bitmap 로고는 사용하지 않습니다.

## 실행 정책

- 동일 프로젝트의 chat, research, engineering job은 하나의 FIFO lane을 공유합니다.
- 다른 프로젝트는 설정된 전역 concurrency 안에서 병렬 실행됩니다.
- 성공한 단계만 checkpoint로 commit됩니다.
- 실패한 부분 산출물은 quarantined 상태로 남아 evidence와 final output에서 제외됩니다.
- Browser, WebFetch, remote coordinate fetch는 동일한 public URL 정책과 redirect 검증을 사용합니다.
- API key와 OAuth token은 event, report, log에 기록하지 않습니다.

## 주요 환경 변수

- `AETHEROPS_DATA_DIR`: 데이터 루트
- `AETHEROPS_PORT`: HTTP 포트, 기본 `5179`
- `AETHEROPS_HOST`: loopback host, 기본 `127.0.0.1`
- `AETHEROPS_RPC_TOKEN`: 로컬 RPC/SSE 인증 token 재정의
- `AETHEROPS_MARKDOWN_BOM`: Windows용 Markdown BOM 정책 재정의

생성되는 Markdown, JSON, JSONL, NT 파일은 UTF-8입니다. PowerShell 5.1에서 한글이 깨져 보이면 `Get-Content -Encoding UTF8`을 사용하십시오.
