# Security hardening backlog

## DNS-01 — 검증된 주소로 연결 pinning

- severity: High
- evidence with file:line: `src/server/runtime/tools/publicUrlPolicy.ts`의 DNS 사전검사 후 `src/server/runtime/tools/boundedHttpClient.ts`가 일반 `fetch`로 호스트명을 다시 해석한다. Playwright도 `src/server/runtime/browser/browserNetworkPolicy.ts`의 사전검사와 실제 연결이 분리되어 있다.
- proposed invariant: 각 HTTP hop은 검증된 public IP에 연결하고 원래 Host/TLS SNI와 인증서 검증을 유지하며, 검증되지 않은 주소로 fallback하지 않는다.
- acceptance criteria: public→private 재해석, mixed answers, CNAME, IPv4/IPv6, redirect별 변경이 모두 차단된다.
- required tests: injected resolver/dispatcher 통합 테스트와 loopback rebinding 서버; 브라우저 엔진의 완화책 및 residual risk 검증.
- compatibility concerns: Undici dispatcher 수명, connection pool 격리, TLS와 프록시 동작.
- owner decision needed: Playwright DNS pinning을 지원 가능한 별도 네트워크 프록시로 강제할지 결정.
- dependencies: dispatcher 설계, Windows/Linux 네트워크 테스트 환경.

## BROWSER-02 — 다운로드·프로필 수명과 전체 예산

- severity: Medium
- evidence with file:line: `src/server/runtime/browser/backgroundBrowserRuntime.ts`는 이번 변경으로 다운로드를 기본 거부하고 텍스트/스크린샷 캡처를 제한하지만 profile quota와 retention을 관리하지 않는다.
- proposed invariant: 프로젝트별 다운로드 opt-in, 파일/MIME/quota, partial cleanup, profile quota/retention을 영속 정책으로 강제한다.
- acceptance criteria: 프로젝트 격리, 초과 시 structured failure, 삭제와 취소 후 임시 파일 0.
- required tests: large/redirect download, abort cleanup, project A/B 격리, profile expiry.
- compatibility concerns: 기존 persistent profile 로그인 상태가 만료될 수 있다.
- owner decision needed: 기본 보존 기간과 다운로드 기능의 제품 필요성.
- dependencies: settings schema와 migration, quota journal.

## SECRET-01 — OS-backed key protection

- severity: Medium
- evidence with file:line: `src/server/runtime/storage/settingsSecrets.ts`의 machine-derived key는 동일 계정의 파일 접근 공격자에 대한 강한 경계가 아니다.
- proposed invariant: KeyProtector 인터페이스 뒤에서 Windows DPAPI, macOS Keychain, Linux Secret Service를 우선 사용하고 legacy ciphertext는 versioned migration으로만 읽는다.
- acceptance criteria: 원자 migration, 실패 시 원본 보존, secret/ciphertext 비로그, OS별 readback과 rollback.
- required tests: legacy migration, hostname/home 변경, 다른 사용자, damaged ciphertext, credential-store failure.
- compatibility concerns: native dependency 배포와 headless Linux 지원.
- owner decision needed: 지원 OS별 credential backend와 명시적 legacy fallback 정책.
- dependencies: packaging 검증과 schema migration.

## CI-02 — targeted coverage와 dependency review

- severity: Low
- evidence with file:line: `package.json`에 coverage provider가 없고 `.github/workflows/ci.yml`에 dependency review가 없다.
- proposed invariant: 보안 경계 모듈별 coverage ratchet은 낮아지지 않고 PR dependency diff를 검토한다.
- acceptance criteria: 최초 baseline을 기록한 뒤 module별 threshold 적용; fork PR에 self-hosted secret 작업 미실행.
- required tests: CI dry run, intentionally lowered coverage/dependency advisory failure fixture.
- compatibility concerns: Vitest provider 버전과 GitHub dependency graph 사용 가능 여부.
- owner decision needed: advisory severity 정책과 coverage threshold.
- dependencies: 저장소 GitHub 보안 설정.

## TS-01 — 엄격 옵션 단계적 적용

- severity: Low
- evidence with file:line: `tsconfig*.json`은 `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`를 전역 강제하지 않는다.
- proposed invariant: 보안·네트워크·저장소 패키지부터 작은 PR로 옵션을 적용하며 `any`나 non-null assertion으로 오류를 숨기지 않는다.
- acceptance criteria: 대상 패키지 오류 0, 회귀 테스트 통과, 전역 오류 수 ratchet 기록.
- required tests: typecheck 및 public contract compile tests.
- compatibility concerns: 외부 타입 정의와 optional property 직렬화.
- owner decision needed: 패키지별 적용 순서.
- dependencies: 별도 tsconfig project references 검토.
