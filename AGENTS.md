# AetherOps 작업 지침

1. mock, synthetic success, 조용한 fallback을 사용하지 않는다. 준비되지 않은 기능은 명시적으로 blocked 또는 failed로 처리한다.
2. CPU 연산은 결정론을 유지하면서 bounded 멀티코어 실행을 기본으로 설계한다.
3. 이 저장소와 사용자가 명시한 입력만 다루며 다른 프로젝트의 파일을 열지 않는다.
4. 사용자의 기존 변경과 로컬 `.aetherops` 데이터를 임의로 reset, 삭제 또는 덮어쓰지 않는다.
5. 공개 RPC/SSE 계약, SQLite 스키마, 마이그레이션 및 계층 경계를 바꾸면 호환성과 검증 근거를 함께 남긴다.
6. 비밀, 쿠키, 토큰, 전체 공급자 응답, 사용자 파일 내용은 로그와 테스트 산출물에 기록하지 않는다.

## 필수 검증

변경 범위에 맞는 targeted test를 먼저 실행하고, 완료 전에는 가능한 범위에서 다음을 확인한다.

```text
npm run format:check
npm run lint
npm run architecture:check
npm run size:check
npm run typecheck
npm test
npm run build
```

마이그레이션 변경은 별도 임시 data root에서 check/apply/verify/재실행 무변경/rollback readback을 검증한다. 실제 `.aetherops`에는 검증된 cutover 전까지 쓰지 않는다.
