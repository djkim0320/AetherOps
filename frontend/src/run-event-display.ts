const EVENT_LABELS: Record<string, string> = {
  "stage.retry_authorized": "툴 계약을 조정하고 계획을 다시 시도합니다",
  "tool.package_proposed": "필요한 프로젝트 툴을 구성했습니다",
  "stage.started": "연구 단계를 시작했습니다",
  "engineering.job.started": "공학 해석을 실행하고 있습니다",
  "engineering.job.succeeded": "공학 해석 결과를 검증했습니다",
  "artifact.published": "검증된 산출물을 저장했습니다",
  "evidence.captured": "출처 원문을 근거로 고정했습니다"
};

export function runEventLabel(kind: string): string {
  const normalized = kind.trim();
  return EVENT_LABELS[normalized] ?? (normalized || "연구 활동");
}
