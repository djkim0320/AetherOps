const EVENT_LABELS: Record<string, string> = {
  "run.created": "연구 실행을 만들었습니다",
  "run.transition": "연구 상태가 변경되었습니다",
  "stage.retry_authorized": "툴 계약을 조정하고 계획을 다시 시도합니다",
  "tool.package_proposed": "필요한 프로젝트 툴을 구성했습니다",
  "stage.started": "연구 단계를 시작했습니다",
  "engineering.job.started": "공학 해석을 실행하고 있습니다",
  "engineering.job.succeeded": "공학 해석 결과를 검증했습니다",
  "artifact.published": "검증된 산출물을 저장했습니다",
  "evidence.captured": "출처 원문을 근거로 고정했습니다"
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const STAGE_LABELS: Record<string, string> = {
  plan: "계획 수립",
  collect: "자료 수집",
  synthesize: "보고서 종합",
  review: "품질 검토"
};

const STATUS_LABELS: Record<string, string> = {
  queued: "대기",
  planning: "계획 수립",
  collecting: "자료 수집",
  synthesizing: "보고서 종합",
  reviewing: "품질 검토",
  revising: "보완 연구",
  waiting_approval: "승인 대기",
  succeeded: "완료",
  failed: "실패",
  quality_failed: "품질 기준 미달",
  cancelled: "취소",
  interrupted: "중단",
  uncertain: "확인 필요"
};

export function runEventLabel(kind: string, payload?: unknown): string {
  const normalized = kind.trim();
  const details = record(payload);
  if (normalized === "stage.started") {
    const stage = typeof details?.stage === "string" ? STAGE_LABELS[details.stage] : undefined;
    const ordinal = typeof details?.ordinal === "number" ? details.ordinal : undefined;
    if (stage === "자료 수집" && ordinal !== undefined) return `자료 수집기 ${ordinal + 1}을 시작했습니다`;
    if (stage) return `${stage}을 시작했습니다`;
  }
  if (normalized === "run.transition") {
    const from = typeof details?.from === "string" ? STATUS_LABELS[details.from] : undefined;
    const to = typeof details?.to === "string" ? STATUS_LABELS[details.to] : undefined;
    if (to === "실패" && from) return `${from} 중 실행이 실패했습니다`;
    if (from && to) return `${from}에서 ${to}(으)로 이동했습니다`;
  }
  return EVENT_LABELS[normalized] ?? (normalized || "연구 활동");
}
