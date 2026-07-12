# Contributing

Node 버전은 `.node-version`을 따르고 `npm ci`로 의존성을 설치한다. 변경 전 `git status`를 확인하며 사용자 변경과 실제 `.aetherops` 데이터를 보존한다.

보안·네트워크·저장소 경계 변경은 실패하는 최소 회귀 테스트를 먼저 추가한다. 이후 targeted test와 `npm run format:check`, `npm run lint`, `npm run architecture:check`, `npm run size:check`, `npm run typecheck`, `npm test`, `npm run build`를 실행한다. 실네트워크와 실제 OAuth 검증은 명시된 live 작업에서만 수행한다.

마이그레이션은 additive, idempotent, checksum 검증 가능해야 한다. 임시 data root에서 backup manifest, integrity, semantic readback, 두 번째 apply 변경 0, rollback을 확인한다. 공개 API/RPC/SSE나 데이터 형식을 바꾸면 migration 또는 명시적인 cutover 문서를 포함한다.

생성 파일은 `.tmp` 또는 문서화된 output 경로에 두며 토큰, 쿠키, 비밀, 사용자 데이터와 공급자 원문을 커밋하지 않는다.
