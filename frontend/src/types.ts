import type { RunControlRef } from "./run-controls";

export type JsonRecord = Record<string, unknown>;

export type Project = {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
};

export type ConversationSession = {
  id: string;
  project_id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
  last_run_at?: string;
  last_run_status?: string;
  active_runs_count?: number;
  uncertain_runs_count?: number;
};

export type Run = {
  id: string;
  project_id: string;
  conversation_session_id: string;
  question: string;
  status: string;
  current_stage?: string;
  revision?: number;
  revision_cycle?: number;
  model?: string;
  reasoning_effort?: string;
  service_tier?: string;
  context_profile?: string;
  blocking_run?: RunControlRef;
  error?: string;
  created_at?: string;
  updated_at?: string;
};

export type ModelOption = {
  id: string;
  display_name: string;
  default_reasoning_effort: string;
  supported_reasoning_efforts: string[];
  supported_speeds: Speed[];
};

export type Speed = "standard" | "fast";

export type ContextProfile = "default" | "long_1m";

export type ChatMode = "chat" | "plan";

export type PlanOption = {
  id: string;
  label: string;
  description: string;
  is_recommended?: boolean;
};

export type PlanQuestion = {
  id: string;
  header: string;
  question: string;
  options: PlanOption[];
};

export type PlanSelection = {
  optionID: string;
  custom: string;
};

export type ChatMessage = {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "system";
  text: string;
  mode: ChatMode;
  createdAt: string;
  planReady?: boolean;
  planQuestions?: PlanQuestion[];
  planCycleID?: string;
  attachments?: Array<{ name: string; kind: "text" | "image" | "document" }>;
};

export type ChatReply = {
  text?: string;
  mode?: ChatMode;
  plan_ready?: boolean;
  plan_questions?: PlanQuestion[];
  plan_cycle_id?: string;
  run_id?: string;
  status?: string;
};

export type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  mode?: ChatMode;
  created_at?: string;
  plan_ready?: boolean;
  plan_questions?: PlanQuestion[];
  plan_cycle_id?: string;
};

export type ConversationPlanCycle = {
  id: string;
  conversation_session_id: string;
  project_id: string;
  status: "active" | "ready" | "discarded" | "executed";
  initial_goal?: string;
  final_plan?: string;
  active_turn?: number;
  max_turns?: number;
  created_at?: string;
  updated_at?: string;
};

export type ContextWindowUsage = {
  available: boolean;
  thread_id?: string;
  turn_id?: string;
  current_tokens: number;
  context_window: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  used_percent: number;
  updated_at?: string;
};

export type CodexAccountStatus = {
  authenticated: boolean;
  chatgpt: boolean;
  plan_type?: string;
};

export type Artifact = {
  id: string;
  run_id: string;
  kind: string;
  created_at?: string;
  adopted?: boolean;
};

export type Approval = {
  id: string;
  run_id: string;
  kind?: string;
  risk?: string;
  summary?: string;
  server?: string;
  tool?: string;
  command?: string;
  arguments_json?: string;
  created_at?: string;
};

export type Schedule = {
  id: string;
  project_id: string;
  conversation_session_id: string;
  question: string;
  kind: "every" | "at" | "cron";
  expression: string;
  timezone?: string;
  enabled: boolean;
  next_run_at?: string;
  last_run_at?: string;
  created_at?: string;
};

export type BrowserOperationalStatus = {
  status: string;
  mode: "automatic" | "manual";
  active_surface?: string;
  tab_count?: number;
  window_visible?: boolean;
  emergency_stopped?: boolean;
  profile_reset_pending?: boolean;
  last_observed_at?: string | null;
};

export type Connection = "checking" | "connected" | "offline";

export type View =
  | "workspace"
  | "knowledge"
  | "tools"
  | "artifacts"
  | "schedules"
  | "controls"
  | "settings";

export type Stage = "plan" | "collect" | "synthesize" | "review";

export const STAGE_DEFINITIONS: Array<{ key: Stage; label: string; korean: string }> = [
  { key: "plan", label: "PLAN", korean: "계획 수립" },
  { key: "collect", label: "COLLECT", korean: "정보 수집" },
  { key: "synthesize", label: "SYNTHESIZE", korean: "보고서 종합" },
  { key: "review", label: "REVIEW", korean: "품질 검토" }
];

export const SLASH_COMMANDS: Array<{
  command: string;
  label: string;
  description: string;
  glyph: string;
}> = [
  {
    command: "/plan",
    label: "계획 모드",
    description: "대화형 질문으로 연구 목표와 범위를 명확히 정리합니다.",
    glyph: "P"
  },
  {
    command: "/chat",
    label: "일반 대화",
    description: "계획 모드를 종료하고 자유롭게 묻고 답합니다.",
    glyph: "C"
  },
  {
    command: "/research",
    label: "연구 실행",
    description: "정리된 계획으로 심층 연구 파이프라인을 즉시 시작합니다.",
    glyph: ">"
  },
  {
    command: "/help",
    label: "명령어 도움말",
    description: "사용 가능한 슬래시 명령어를 확인합니다.",
    glyph: "?"
  }
];

export const STATUS_LABELS: Record<string, string> = {
  queued: "대기 중",
  planning: "계획 수립 중",
  collecting: "자료 수집 중",
  synthesizing: "보고서 종합 중",
  reviewing: "품질 검토 중",
  revising: "보고서 보완 중",
  waiting_approval: "승인 대기",
  succeeded: "완료",
  failed: "실패",
  quality_failed: "품질 기준 미달",
  cancelled: "취소됨",
  interrupted: "중단됨",
  uncertain: "확인 필요"
};
