# Security Policy

## 지원 범위

AetherOps 0.2는 loopback에 바인딩되는 로컬 단일 사용자 애플리케이션이다. 원격 노출은 지원하지 않으며, 과거 `AETHEROPS_ALLOW_NON_LOOPBACK_HOST` 설정은 보안 경계를 확장하지 않고 시작을 거부한다. 네트워크 프록시나 포트 포워딩으로 외부에 공개하지 않는다.

주요 신뢰 경계는 브라우저/RPC 입력, 외부 HTTP와 Playwright 탐색, Codex CLI 프로세스, SQLite와 프로젝트 파일, 암호화 설정이다. RPC와 SSE는 동일한 쿠키·Host·Origin 경계를 사용한다. 외부 URL은 public-address 및 source policy 검사를 통과해야 하지만 DNS 연결 pinning은 아직 구현되지 않았으므로 관련 위험은 [hardening backlog](docs/hardening-backlog.md)에 기록되어 있다.

## 취약점 신고

공개 이슈에 토큰, 데이터베이스, 프로젝트 파일, 전체 로그 또는 재현용 비밀을 올리지 않는다. 저장소 소유자에게 비공개 채널로 영향 버전, 최소 재현, 예상 영향만 전달한다. 지원 버전과 비공개 신고 채널은 배포 전에 저장소 소유자가 확정해야 한다.

## 비밀과 산출물

- OAuth 토큰, API 키, 쿠키와 원문 공급자 응답을 로그·SSE·보고서에 저장하지 않는다.
- `.aetherops`, `.tmp`, `output`과 브라우저 프로필은 민감한 로컬 산출물로 취급한다.
- 현재 설정 암호화의 machine-derived key는 OS credential store와 동등한 보호가 아니다. OS-backed key migration 전까지 파일시스템 계정 경계가 필수다.
- 라이선스 파일은 소유자 결정 전까지 임의로 추가하지 않는다.
