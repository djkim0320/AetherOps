import { useState } from "preact/hooks";
import type {
  ChatMessage,
  ChatMode,
  Connection,
  ConversationPlanCycle,
  ConversationSession,
  PlanSelection,
  Project,
  Run
} from "../types";
import { STATUS_LABELS } from "../types";
import { FormattedMessage } from "./FormattedMessage";
import { PlanQuestionnaire } from "./PlanQuestionnaire";

export type ChatWorkspaceProps = {
  transcriptRef: { current: HTMLDivElement | null };
  transcriptItems: Array<{ kind: "chat"; message: ChatMessage }>;
  selectedProject: Project | null;
  selectedSession: ConversationSession | null;
  chatMode: ChatMode;
  activeRun: Run | null;
  connection: Connection;
  planSelections: Record<string, Record<string, PlanSelection>>;
  submittedPlanQuestions: Record<string, boolean>;
  currentPlanCycle: ConversationPlanCycle | null;
  sessionBusy: boolean;
  busy: string | null;
  onSelectSlashCommand: (cmd: string) => void;
  onSelectPlanAnswer: (msgId: string, qId: string, optId: string) => void;
  onSetPlanCustomAnswer: (msgId: string, qId: string, custom: string) => void;
  onSubmitPlanAnswers: (msg: ChatMessage) => void;
  onStartPlannedResearch: (msg: ChatMessage) => void;
  formatDate: (val: unknown) => string;
};

export function ChatWorkspace({
  transcriptRef,
  transcriptItems,
  selectedProject,
  selectedSession,
  chatMode,
  activeRun,
  connection,
  planSelections,
  submittedPlanQuestions,
  currentPlanCycle,
  sessionBusy,
  busy,
  onSelectSlashCommand,
  onSelectPlanAnswer,
  onSetPlanCustomAnswer,
  onSubmitPlanAnswers,
  onStartPlannedResearch,
  formatDate
}: ChatWorkspaceProps) {
  const [copiedMessageID, setCopiedMessageID] = useState<string | null>(null);

  async function copyMessageText(messageID: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageID(messageID);
      setTimeout(() => setCopiedMessageID(null), 2000);
    } catch {
      // Fallback
    }
  }

  return (
    <section class="chat-panel panel">
      {/* Header */}
      <header class="chat-header">
        <div class="chat-title">
          <span class="chat-title-mark">A</span>
          <div>
            <h2>{selectedSession ? selectedSession.title : "대화 선택 필요"}</h2>
            <p>
              {selectedProject
                ? `${selectedProject.name} · ${chatMode === "plan" ? "계획을 다듬는 중" : "일반 대화"}`
                : "프로젝트 선택 필요"}
            </p>
          </div>
        </div>

        <div class="chat-header-status">
          <span class={`mode-chip ${chatMode === "plan" ? "plan" : ""}`}>
            <i>{chatMode === "plan" ? "P" : "C"}</i>
            {chatMode === "plan" ? "계획 모드" : "대화"}
          </span>
          {activeRun && (
            <span class={`status-chip ${activeRun.status}`}>
              {STATUS_LABELS[activeRun.status] ?? activeRun.status}
            </span>
          )}
          <span class="header-connection" title="코어 연결됨">
            <span class="live-dot" />
            {connection === "connected" ? "연결됨" : "확인 중"}
          </span>
        </div>
      </header>

      {/* Transcript */}
      <div
        ref={transcriptRef}
        class={transcriptItems.length > 0 ? "chat-transcript has-messages" : "chat-transcript"}
        aria-live="polite"
      >
        {transcriptItems.length === 0 ? (
          <div class="chat-welcome">
            <div class="welcome-mark">A</div>
            <h2>무엇을 연구해 볼까요?</h2>
            <p>
              AetherOps와 편하게 대화하다가, 복합 연구가 필요할 때는 <strong>계획 모드</strong>로
              접근 방식과 검증 범위를 정리하고 시작할 수 있습니다.
            </p>
            <div class="welcome-actions">
              <button type="button" onClick={() => onSelectSlashCommand("/plan")}>
                계획 세우기 <kbd>/plan</kbd>
              </button>
              <button type="button" onClick={() => onSelectSlashCommand("/help")}>
                명령어 보기 <kbd>/</kbd>
              </button>
            </div>
          </div>
        ) : (
          transcriptItems.map((item) => {
            const message = item.message;
            if (message.role === "user") {
              return (
                <article class="chat-turn chat-only-turn" key={message.id}>
                  <div class="message-row user-row">
                    <div
                      class={`message user-message ${
                        message.mode === "plan" ? "plan-message" : ""
                      }`}
                      title={formatDate(message.createdAt)}
                    >
                      <p>{message.text}</p>
                    </div>
                  </div>
                </article>
              );
            }
            if (message.role === "system") {
              return (
                <article
                  class={`mode-event ${message.mode === "plan" ? "plan" : ""}`}
                  key={message.id}
                >
                  <span>{message.mode === "plan" ? "P" : "C"}</span>
                  <div>
                    <strong>{message.mode === "plan" ? "계획 모드" : "AetherOps"}</strong>
                    <p>{message.text}</p>
                  </div>
                </article>
              );
            }
            // Assistant Turn
            return (
              <article
                class={`chat-turn chat-only-turn assistant-turn ${
                  message.mode === "plan" ? "plan-turn" : ""
                }`}
                key={message.id}
              >
                <div class="message-row assistant-row">
                  <div class="assistant-avatar">A</div>
                  <div
                    class={`message assistant-message ${
                      message.mode === "plan" ? "plan-response" : ""
                    }`}
                  >
                    <div class="assistant-message-head">
                      <span class="message-meta">
                        {message.mode === "plan"
                          ? message.planReady
                            ? "최종 계획"
                            : "계획 인터뷰"
                          : "AetherOps"}
                      </span>
                      <div class="assistant-message-actions">
                        <button
                          type="button"
                          class="msg-quick-btn"
                          onClick={() => copyMessageText(message.id, message.text)}
                          title="답변 복사"
                          aria-label="답변 복사"
                        >
                          {copiedMessageID === message.id ? "✓" : "복사"}
                        </button>
                        {message.mode === "plan" && (
                          <span class="plan-response-badge">
                            {message.planReady ? "READY" : "PLAN"}
                          </span>
                        )}
                      </div>
                    </div>

                    <FormattedMessage text={message.text} />

                    {Boolean(message.planQuestions?.length) && (
                      <PlanQuestionnaire
                        message={message}
                        selections={planSelections[message.id] ?? {}}
                        submitted={submittedPlanQuestions[message.id] === true}
                        disabled={
                          sessionBusy ||
                          busy === "run" ||
                          message.planCycleID !== currentPlanCycle?.id ||
                          currentPlanCycle?.status !== "active"
                        }
                        onSelect={(questionID, optionID) =>
                          onSelectPlanAnswer(message.id, questionID, optionID)
                        }
                        onCustom={(questionID, value) =>
                          onSetPlanCustomAnswer(message.id, questionID, value)
                        }
                        onSubmit={() => onSubmitPlanAnswers(message)}
                      />
                    )}

                    {message.mode === "plan" && message.planReady && (
                      <div class="plan-response-actions">
                        <button
                          type="button"
                          class="plan-start-research-btn"
                          onClick={() => onStartPlannedResearch(message)}
                          disabled={
                            busy === "run" ||
                            sessionBusy ||
                            message.planCycleID !== currentPlanCycle?.id ||
                            currentPlanCycle?.status !== "ready"
                          }
                        >
                          <span>›</span> 이 계획으로 연구 시작
                        </button>
                        <code>/research</code>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
