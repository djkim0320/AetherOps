import type { CodexModelId, CodexReasoningEffort } from "../../contracts/api-v2/settings.js";

/** Product copy and presentation helpers for the fixed Korean renderer locale. */
export const ko = {
  brand: "AetherOps",
  projectWorkspace: "프로젝트 워크스페이스",
  researchWorkspace: "연구 워크스페이스",
  desktopWorkspace: "데스크톱 워크스페이스",
  largerViewportRequired: "더 큰 화면이 필요합니다.",
  desktopRequirement: (width: number, height: number) => "AetherOps는 연구 워크스페이스에 최소 " + width + "×" + height + " 화면이 필요합니다.",
  routeUnavailable: "경로를 사용할 수 없음",
  routeCouldNotRender: "이 화면을 표시할 수 없습니다.",
  returnToOverview: "개요로 돌아가기",
  loadingApp: "AetherOps 불러오는 중…",
  projects: "프로젝트",
  newProject: "새 프로젝트",
  settings: "설정",
  expandRail: "프로젝트 사이드바 펼치기",
  collapseRail: "프로젝트 사이드바 접기",
  useLightTheme: "라이트 테마 사용",
  useDarkTheme: "다크 테마 사용",
  hideInspector: "인스펙터 숨기기",
  showInspector: "인스펙터 표시",
  closeDialog: "대화상자 닫기",
  connections: "연결",
  tools: "도구",
  appearance: "화면 설정",
  researchBrief: "연구 개요",
  runPolicy: "실행 정책",
  chat: "채팅",
  newTask: "새 작업",
  createProject: "프로젝트 만들기",
  project: "프로젝트",
  projectSearch: "프로젝트 검색",
  taskSearch: "작업 검색",
  recentProjects: "최근 프로젝트",
  loadingProjects: "프로젝트 불러오는 중…",
  projectsUnavailable: "프로젝트를 사용할 수 없습니다.",
  noMatchingTasks: "일치하는 작업이 없습니다.",
  createProjectToBegin: "프로젝트를 만들어 시작하세요.",
  pickUpWhereLeftOff: "최근 작업 이어가기",
  continueProject: "프로젝트를 열어 대화·실행 기록·근거를 이어보세요.",
  newProjectDescription: "대화와 연구 실행에 사용할 영구 연구 개요를 정의하세요.",
  createResearchProject: "연구 프로젝트 만들기",
  createResearchBrief: "연구 개요를 작성해 시작하세요.",
  noProjects: "아직 프로젝트가 없습니다.",
  loadingSettings: "설정 불러오는 중…",
  loadingConnections: "연결 정보 불러오는 중…",
  loadingProject: "프로젝트 불러오는 중…",
  cancel: "취소",
  save: "저장",
  saving: "저장 중…",
  creating: "생성 중…",
  saved: "저장됨",
  topic: "주제",
  goal: "목표",
  scope: "범위",
  budget: "예산",
  budgetAndConstraints: "예산 및 제약 조건",
  researchConversation: "연구 대화",
  unnamedProject: "이름 없는 프로젝트",
  message: "메시지",
  messages: "메시지",
  queued: "대기 중",
  startResearchConversation: "연구 대화 시작",
  explore: (topic: string) => topic + " 살펴보기",
  whatToResearch: "무엇을 연구할까요?",
  conversationHint: "질문·가설·필요한 근거를 입력하세요. 작업은 영속 큐에 추가되며 진행 상황은 실행 바에 표시됩니다.",
  you: "나",
  askResearch: "AetherOps에 조사·비교·검증을 요청하세요…",
  enterToSend: "Enter로 전송 · Shift+Enter로 줄바꿈",
  sendingMessage: "메시지 전송 중",
  sendMessage: "메시지 보내기",
  disclaimer: "AetherOps의 답변에는 오류가 있을 수 있습니다. 중요한 근거와 공학 결과를 확인하세요.",
  researchRun: "연구 실행",
  updatesDisconnected: "업데이트 연결 끊김",
  reconnect: "다시 연결",
  start: "시작",
  pause: "일시정지",
  resume: "재개",
  abort: "중단",
  runBlocked: "실행 차단됨",
  runFailed: "실행 실패",
  startResearchRun: "연구 실행 시작",
  resumeResearchRun: "연구 실행 재개",
  policyDescription: "이 작업의 최대 권한과 소스 범위를 확인하세요. 큐에 추가된 후 권한을 늘릴 수 없습니다.",
  sourceAccess: "소스 접근",
  sourceAccessMode: "소스 접근 모드",
  offline: "오프라인",
  exactUrlAllowlist: "정확한 URL 허용 목록",
  publicDiscovery: "공개 검색",
  allowedUrls: "허용 URL",
  allowedDomains: "허용 도메인(비어 있으면 공개 웹)",
  oneValuePerLine: "한 줄에 하나씩 입력",
  codexWorkspaceExecution: "Codex 워크스페이스 실행",
  codexWorkspaceDescription: "오프라인 스테이징에서 실행되며 에이전트·엔지니어링 권한이 필요합니다. 기본값은 꺼짐입니다.",
  allowCodexWorkspaceExecution: "Codex 워크스페이스 실행 허용",
  inspector: "프로젝트 인스펙터",
  inspectorView: "인스펙터 보기",
  run: "실행",
  evidence: "근거",
  artifacts: "산출물",
  execution: "실행",
  runHistory: "실행 기록",
  updating: "업데이트 중…",
  runHistoryUnavailable: "실행 기록을 사용할 수 없습니다.",
  runTraceUnavailable: "실행 추적을 사용할 수 없습니다.",
  noActiveStep: "활성 단계 없음",
  committedRecords: "커밋된 기록",
  promotedOutputs: "승격된 출력",
  selectedRunTrace: "선택한 실행 추적",
  selectedRun: "선택한 실행",
  selected: (value: string) => "선택한 " + value,
  traceAvailable: "추적 가능",
  legacyRunWithoutTrace: "추적 없는 레거시 실행",
  blockedReason: "차단 사유",
  failureReason: "실패 사유",
  requestedCapabilities: "요청 권한",
  noDecisionSummary: "결정 요약 없음",
  validatedInput: "검증된 입력",
  policy: "정책",
  checkpointed: "체크포인트 저장됨",
  input: "입력",
  output: "출력",
  terminalCause: "종료 원인",
  noToolDecisions: "기록된 도구 결정 없음",
  codexCliExecution: "Codex CLI 실행",
  runtime: "런타임",
  sandbox: "샌드박스",
  progressEvents: "진행 이벤트",
  duration: "기간",
  termination: "종료",
  workspaceManifest: "워크스페이스 매니페스트",
  outputManifest: "출력 매니페스트",
  noCommittedEvidence: "커밋된 근거가 없습니다.",
  noCommittedArtifacts: "커밋된 산출물이 없습니다.",
  codexOnlyDescription: "AetherOps는 Codex OAuth를 유일한 오케스트레이터 LLM으로 사용합니다.",
  connectionsDescription: "임베딩·검색 제공자는 Codex와 독립적으로 유지됩니다.",
  toolsDescription: "런타임 준비 상태를 표시합니다. 사용할 수 없는 도구는 조용히 대체하지 않습니다.",
  appearanceDescription: "테마 설정은 이 기기에만 저장됩니다.",
  embedding: "임베딩",
  webSearch: "웹 검색",
  noModel: "모델 없음",
  keyConfigured: "키 설정됨",
  keyRequired: "키 필요",
  diagnosticsUnavailable: "진단 정보를 사용할 수 없습니다.",
  theme: "테마",
  dark: "다크",
  light: "라이트",
  reducedMotion: "동작 감소",
  followsSystemPreference: "운영 체제 설정을 따릅니다.",
  codex: "Codex",
  model: "모델",
  selectedModelDetails: "선택한 모델 세부 정보",
  experimental: "실험용",
  sparkEntitlement: "ChatGPT Pro 권한 필요. 텍스트 전용 연구 미리보기.",
  reasoningEffort: "추론 강도",
  maxReasoningNote: "최대 추론은 GPT-5.6 제품군에서만 사용할 수 있습니다.",
  plannerTimeout: "플래너 제한 시간(ms)",
  workspaceTaskTimeout: "워크스페이스 작업 제한 시간(ms)",
  workspaceTimeoutNote: "명시적으로 승인된 Codex 워크스페이스 실행에만 적용됩니다.",
  recommended: "권장",
  compatibility: "호환",
  experimentalGroup: "실험용",
  researchBriefDescription: "대화와 연구 실행이 공유하는 영구 의도",
  runPolicyDescription: "프로젝트 권한은 앱·작업 권한과 교집합으로 계산됩니다.",
  agent: "에이전트",
  engineering: "엔지니어링",
  search: "검색",
  agentHelp: "Codex 계획과 명시적으로 승인된 워크스페이스 실행을 허용합니다.",
  engineeringHelp: "solver와 엔지니어링 워크벤치를 허용합니다.",
  searchHelp: "공개 웹 검색·가져오기·브라우저·원격 좌표를 허용합니다.",
  confirmAgentRequired: "에이전트 권한이 필요합니다.",
  confirmEngineeringDenied: "프로젝트 정책에서 엔지니어링을 거부했습니다.",
  confirmSearchDenied: "프로젝트 정책에서 검색을 거부했습니다.",
  confirmSearchRequired: "네트워크 소스 접근에는 검색을 켜야 합니다.",
  confirmUrlRequired: "허용 URL을 하나 이상 입력하세요.",
  confirmCodexEngineeringRequired: "Codex 워크스페이스 실행에는 엔지니어링 권한이 필요합니다.",
  compatibleEffortRequired: "호환되는 추론 강도를 선택하세요.",
  timeoutRange: "제한 시간은 1,000~900,000ms 정수여야 합니다.",
  workspaceTimeoutRange: "워크스페이스 작업 제한 시간은 1,000~900,000ms 정수여야 합니다.",
  genericRequestError: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  serverUnavailable: "서버에 연결하지 못했습니다.",
  invalidServerResponse: "서버 응답을 읽지 못했습니다.",
  queueUnavailable: "작업 큐를 사용할 수 없습니다.",
  unsupportedModel: "지원되지 않는 Codex 모델입니다.",
  authenticationRequired: "Codex 인증이 필요합니다.",
  accessUnavailable: "선택한 모델을 현재 계정에서 사용할 수 없습니다.",
  projectRevisionChanged: "프로젝트가 변경되었습니다. 화면을 새로고침한 뒤 다시 시도하세요.",
  notFound: "요청한 항목을 찾을 수 없습니다.",
  capabilityDenied: "요청한 권한이 허용되지 않았습니다.",
  notReady: "필수 도구나 연결이 아직 준비되지 않았습니다.",
  interrupted: "작업이 중단되었습니다. 완료된 체크포인트에서 재개할 수 있습니다.",
  methodNotFound: "지원하지 않는 요청입니다.",
  internalError: "내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  statusChecking: "확인 중",
  access: "접근 권한",
  catalog: "카탈로그",
  ready: "준비됨",
  blocked: "차단됨",
  unavailable: "사용할 수 없음",
  error: "오류",
  notAuthenticated: "인증되지 않음",
  on: "켜짐",
  off: "꺼짐",
  now: "방금 전",
  agoMinutes: (value: number) => value + "분 전",
  agoHours: (value: number) => value + "시간 전",
  agoDays: (value: number) => value + "일 전",
  noActiveRun: "새 실행 준비됨"
} as const;

export type TranslationKey = keyof typeof ko;

const shortDateFormatter = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" });
const timestampFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

export function t(key: TranslationKey): string {
  const value = ko[key];
  return typeof value === "string" ? value : key;
}

const STATUS_LABELS: Record<string, string> = {
  idle: "대기",
  queued: ko.queued,
  running: "실행 중",
  pause_requested: "일시정지 요청됨",
  paused: "일시정지됨",
  cancel_requested: "중단 요청됨",
  aborted: "중단됨",
  interrupted: "중단됨",
  blocked: ko.blocked,
  failed: "실패",
  completed: "완료",
  accepted: "허용됨",
  rejected: "거부됨",
  pending: "대기 중",
  supported: "지원됨",
  unsupported: "지원되지 않음",
  not_checked: "확인되지 않음",
  available: "사용 가능",
  unavailable: ko.unavailable,
  not_authenticated: ko.notAuthenticated,
  error: ko.error
};

const STEP_LABELS: Record<string, string> = {
  CREATE_RESEARCH_DB: "연구 DB 생성",
  INPUT_RESEARCH_QUESTION_HYPOTHESIS: "연구 질문·가설 입력",
  BUILD_RESEARCH_SPECIFICATION: "연구 명세 작성",
  PLAN_RESEARCH: "연구 계획 수립",
  EXECUTE_TOOLS: "도구 실행",
  NORMALIZE_DATA: "데이터 정규화",
  BUILD_VECTOR_INDEX: "벡터 인덱스 구축",
  BUILD_ONTOLOGY_GRAPH: "온톨로지 그래프 구축",
  REASON_AND_VALIDATE: "추론 및 검증",
  SYNTHESIZE_AND_EVALUATE: "종합 및 가설 평가",
  DECIDE_CONTINUATION: "계속 연구 여부 결정",
  FINALIZE_OUTPUTS: "최종 산출물 확정"
};

const CAPABILITY_LABELS: Record<string, string> = { agent: ko.agent, engineering: ko.engineering, search: ko.search };
const TOOL_STATUS_LABELS: Record<string, string> = { ready: ko.ready, blocked: ko.blocked, unavailable: ko.unavailable };
const CATEGORY_LABELS: Record<string, string> = { agent: ko.agent, engineering: ko.engineering, search: ko.search, storage: "저장소" };
const JOB_KIND_LABELS: Record<string, string> = {
  research_loop: "연구 루프",
  chat_reply: "채팅 답변",
  engineering_run: "엔지니어링 실행"
};
const MODEL_DESCRIPTION: Record<CodexModelId, string> = {
  "gpt-5.6": "Codex 오케스트레이션에 사용하는 권장 롤링 별칭입니다.",
  "gpt-5.6-sol": "명시적 GPT-5.6 Sol 모델입니다.",
  "gpt-5.6-terra": "명시적 GPT-5.6 Terra 모델입니다.",
  "gpt-5.6-luna": "명시적 GPT-5.6 Luna 모델입니다.",
  "gpt-5.5": "기존 Codex 워크플로와 호환되는 모델입니다.",
  "gpt-5.4": "기존 Codex 워크플로와 호환되는 모델입니다.",
  "gpt-5.4-mini": "제한된 작업을 위한 소형 호환 모델입니다.",
  "gpt-5.3-codex-spark": "ChatGPT Pro 계정용 텍스트 전용 연구 미리보기입니다."
};
const MODEL_LABELS: Record<CodexModelId, string> = {
  "gpt-5.6": "GPT-5.6",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark"
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function stepLabel(step?: string): string {
  if (!step) return ko.noActiveRun;
  return STEP_LABELS[step] ?? step.replaceAll("_", " ");
}

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export function toolStatusLabel(status: string): string {
  return TOOL_STATUS_LABELS[status] ?? status;
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function jobKindLabel(kind: string): string {
  return JOB_KIND_LABELS[kind] ?? kind;
}

export function modelLabel(model: CodexModelId): string {
  return MODEL_LABELS[model];
}

export function modelDescription(model: CodexModelId): string {
  return MODEL_DESCRIPTION[model];
}

export function reasoningEffortLabel(effort: CodexReasoningEffort): string {
  if (effort === "low") return "낮음";
  if (effort === "medium") return "중간";
  if (effort === "high") return "높음";
  if (effort === "xhigh") return "매우 높음";
  return "최대";
}

export function yesNo(value: boolean): string {
  return value ? ko.on : ko.off;
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const elapsed = now - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return ko.now;
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return ko.now;
  if (minutes < 60) return ko.agoMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ko.agoHours(hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return ko.agoDays(days);
  return shortDateFormatter.format(new Date(value));
}

export function formatTimestamp(value: string): string {
  return timestampFormatter.format(new Date(value));
}

export function localizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = message.toLowerCase();
  if (!message) return ko.genericRequestError;
  if (normalized.includes("failed to fetch") || normalized.includes("fetch failed")) return ko.serverUnavailable;
  if (normalized.includes("invalid json") || normalized.includes("invalid server response")) return ko.invalidServerResponse;
  if (normalized.includes("queue unavailable")) return ko.queueUnavailable;
  if (normalized.includes("unsupported codex model")) return ko.unsupportedModel;
  if (normalized.includes("authentication") || normalized.includes("oauth") || normalized.includes("token is required")) return ko.authenticationRequired;
  if (normalized.includes("not available to this account") || normalized.includes("model is not available")) return ko.accessUnavailable;
  if (normalized.includes("project revision changed") || normalized.includes("revision changed")) return ko.projectRevisionChanged;
  if (normalized.includes("job not found") || normalized.includes("project not found") || normalized.includes("session not found")) return ko.notFound;
  if (normalized.includes("capabilit") && normalized.includes("denied")) return ko.capabilityDenied;
  if (normalized.includes("not ready") || normalized.includes("unavailable")) return ko.notReady;
  if (normalized.includes("interrupted") || normalized.includes("aborted")) return ko.interrupted;
  if (normalized.includes("method") && normalized.includes("not found")) return ko.methodNotFound;
  if (normalized.includes("internal error") || normalized.includes("could not be completed")) return ko.internalError;
  return message;
}

export function localizeCapabilityReason(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("agent") && normalized.includes("required")) return ko.confirmAgentRequired;
  if (normalized.includes("engineering") && normalized.includes("den")) return ko.confirmEngineeringDenied;
  if (normalized.includes("search") && normalized.includes("den")) return ko.confirmSearchDenied;
  if (normalized.includes("not ready")) return ko.notReady;
  return reason;
}
