import { useState } from "preact/hooks";
import type { RunEvent } from "../api";
import type { RunControlRef } from "../run-controls";
import type { Approval, Artifact, Run, Stage, View } from "../types";
import { STAGE_DEFINITIONS, STATUS_LABELS } from "../types";
import { artifactPresentation } from "../artifact-presentation";
import { researchQuestionDisplay } from "../research-display";
import { canDiscardRun } from "../run-controls";
import { runEventLabel } from "../run-event-display";

export type ResearchSummaryRailProps = {
  activeRun: Run | null;
  artifacts: Artifact[] | null;
  selectedArtifactID: string;
  onOpenArtifact: (artifact: Artifact) => void;
  events: RunEvent[];
  approvals: Approval[] | null;
  onDecideApproval: (approval: Approval, decision: "approved" | "denied") => void;
  blockingRun: RunControlRef | null;
  onOpenBlockingRun: () => void;
  warnings: string[];
  onSetView: (v: View) => void;
  busy: string | null;
  onRunAction: (action: "cancel" | "resume" | "discard") => void;
  formatDate: (val: unknown) => string;
  stageState: (stage: Stage, run: Run | null) => "complete" | "active" | "waiting" | "attention";
};

type RailTab = "plan" | "artifacts" | "approvals";

type PortableInstallApproval = {
  package_id?: string;
  approval_sha256?: string;
  source_url?: string;
  payload_sha256?: string;
  publisher?: string;
};

function portableInstallApproval(approval: Approval): PortableInstallApproval | null {
  if (approval.tool !== "tool_package_install" || !approval.arguments_json) return null;
  try {
    const value = JSON.parse(approval.arguments_json) as PortableInstallApproval;
    return value.package_id && value.approval_sha256 ? value : null;
  } catch {
    return null;
  }
}

export function ResearchSummaryRail({
  activeRun,
  artifacts,
  selectedArtifactID,
  onOpenArtifact,
  events,
  approvals,
  onDecideApproval,
  blockingRun,
  onOpenBlockingRun,
  warnings,
  onSetView,
  busy,
  onRunAction,
  formatDate,
  stageState
}: ResearchSummaryRailProps) {
  const [activeTab, setActiveTab] = useState<RailTab>("plan");

  const completedStagesCount = STAGE_DEFINITIONS.filter(
    (stage) => stageState(stage.key, activeRun) === "complete"
  ).length;

  const pendingApprovalsCount = approvals?.length ?? 0;

  return (
    <aside class="research-summary-rail" aria-label="연구 요약">
      <section class="research-summary-card">
        {/* Rail Top Navigation Tabs (No emojis) */}
        <div class="rail-tabs-nav" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "plan"}
            class={`rail-tab-btn ${activeTab === "plan" ? "active" : ""}`}
            onClick={() => setActiveTab("plan")}
          >
            <span>플랜 & 진행</span>
            {activeRun && <span class="rail-tab-badge">{completedStagesCount}/4</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "artifacts"}
            class={`rail-tab-btn ${activeTab === "artifacts" ? "active" : ""}`}
            onClick={() => setActiveTab("artifacts")}
          >
            <span>산출물</span>
            <span class="rail-tab-badge">{artifacts?.length ?? 0}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "approvals"}
            class={`rail-tab-btn ${activeTab === "approvals" ? "active" : ""}`}
            onClick={() => setActiveTab("approvals")}
          >
            <span>승인 & 활동</span>
            {pendingApprovalsCount > 0 && (
              <span class="rail-tab-badge attention">{pendingApprovalsCount}</span>
            )}
          </button>
        </div>

        {/* TAB 1: PLAN & PROGRESS */}
        {activeTab === "plan" && (
          <div class="rail-tab-content">
            <div class="summary-section summary-plan">
              <div class="summary-heading">
                <span>현재 연구 상태</span>
                {activeRun && (
                  <span class={`status-chip ${activeRun.status}`}>
                    {STATUS_LABELS[activeRun.status] ?? activeRun.status}
                  </span>
                )}
              </div>

              <div class="summary-plan-title">
                <span class="summary-icon">•</span>
                <span>
                  <strong>
                    {activeRun
                      ? researchQuestionDisplay(activeRun.question).text
                      : "진행 중인 연구가 없습니다"}
                  </strong>
                  <small>
                    {activeRun
                      ? `${completedStagesCount} / ${STAGE_DEFINITIONS.length} 단계 완료`
                      : "대화에서 계획을 세운 뒤 연구를 시작하세요"}
                  </small>
                </span>
              </div>

              {/* Stage Progress Stepper */}
              <div class="rail-stage-track">
                {STAGE_DEFINITIONS.map((stage) => {
                  const state = stageState(stage.key, activeRun);
                  return (
                    <div key={stage.key} class={`rail-stage-item ${state}`}>
                      <span class="rail-stage-marker">
                        {state === "complete"
                          ? "✓"
                          : stage.key === "plan"
                          ? "1"
                          : stage.key === "collect"
                          ? "2"
                          : stage.key === "synthesize"
                          ? "3"
                          : "4"}
                      </span>
                      <span class="rail-stage-copy">
                        <strong>{stage.label}</strong>
                        <small>{stage.korean}</small>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {warnings.length > 0 && (
              <div class="summary-runtime-warning" role="status">
                <span>!</span>
                <p>{warnings[0]}</p>
                <button type="button" onClick={() => onSetView("settings")}>
                  설정
                </button>
              </div>
            )}

            {activeRun?.status === "queued" && blockingRun && (
              <div class="summary-section run-blocker-notice" role="status">
                <div class="summary-heading">
                  <span>FIFO 대기</span>
                  <span class="count-badge">1</span>
                </div>
                <strong>이전 실행을 먼저 확인해야 합니다.</strong>
                <p>
                  {STATUS_LABELS[blockingRun.status] ?? blockingRun.status} 상태인 다른 대화의 실행이
                  시작을 막고 있습니다.
                </p>
                <button
                  class="button danger-outline small"
                  type="button"
                  onClick={onOpenBlockingRun}
                >
                  막고 있는 실행 열기
                </button>
              </div>
            )}

            {activeRun && (
              <div class="summary-run-actions">
                <button
                  type="button"
                  onClick={() => onRunAction("cancel")}
                  disabled={
                    busy !== null ||
                    ["succeeded", "failed", "cancelled", "quality_failed"].includes(
                      activeRun.status
                    )
                  }
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={() => onRunAction("resume")}
                  disabled={busy !== null || activeRun.status !== "interrupted"}
                >
                  재개
                </button>
                <button
                  type="button"
                  class="danger"
                  onClick={() => onRunAction("discard")}
                  disabled={!canDiscardRun(activeRun.status, busy)}
                >
                  폐기
                </button>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: ARTIFACTS */}
        {activeTab === "artifacts" && (
          <div class="rail-tab-content">
            <div class="summary-section research-artifacts">
              <div class="summary-heading">
                <span>산출물 목록</span>
                <button type="button" onClick={() => onSetView("artifacts")}>
                  <span>전체 화면</span> ›
                </button>
              </div>
              {!activeRun ? (
                <p class="summary-empty">실행을 선택하면 보고서와 근거가 표시됩니다.</p>
              ) : artifacts === null ? (
                <p class="summary-empty">산출물을 불러오는 중…</p>
              ) : artifacts.length === 0 ? (
                <p class="summary-empty">아직 산출물이 없습니다.</p>
              ) : (
                <div class="compact-artifact-list">
                  {artifacts.map((artifact) => {
                    const presentation = artifactPresentation(artifact.kind);
                    return (
                      <button
                        key={artifact.id}
                        class={`compact-artifact ${
                          artifact.id === selectedArtifactID ? "selected" : ""
                        }`}
                        onClick={() => onOpenArtifact(artifact)}
                        title={`${presentation.title} — ${presentation.description}`}
                      >
                        <span class={`artifact-kind ${presentation.tone}`}>
                          {presentation.label}
                        </span>
                        <span class="compact-artifact-copy">
                          <strong>{presentation.title}</strong>
                          <small>{presentation.description}</small>
                          <em>{formatDate(artifact.created_at)}</em>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: APPROVALS & LIVE ACTIVITY */}
        {activeTab === "approvals" && (
          <div class="rail-tab-content">
            <div class="summary-section approvals-panel">
              <div class="summary-heading">
                <span>승인 대기</span>
                <span class={approvals?.length ? "count-badge attention" : "count-badge"}>
                  {approvals?.length ?? "–"}
                </span>
              </div>
              {approvals === null ? (
                <p class="summary-empty">승인 목록을 불러오는 중…</p>
              ) : approvals.length === 0 ? (
                <p class="summary-empty approved">✓ 대기 중인 승인이 없습니다.</p>
              ) : (
                <div class="approval-list">
                  {approvals.map((approval) => {
                    const portable = portableInstallApproval(approval);
                    return (
                    <article class={`approval-item ${portable ? "portable-install-approval" : ""}`} key={approval.id}>
                      <div class="approval-title">
                        <strong>{approval.kind || "작업 승인"}</strong>
                        <span
                          class={`risk-badge risk-${(approval.risk || "unclassified")
                            .toLowerCase()
                            .replace(/[^a-z0-9_-]/g, "-")}`}
                        >
                          {approval.risk || "unclassified"}
                        </span>
                      </div>
                      <p>{approval.summary || "승인 세부 정보가 제공되지 않았습니다."}</p>
                      {portable && (
                        <div class="portable-approval-summary">
                          <strong>Portable CLI 다운로드 및 실행</strong>
                          <span>{portable.publisher || "확인되지 않은 배포자"}</span>
                          <code>{portable.source_url}</code>
                          <small>Payload SHA-256</small>
                          <code>{portable.payload_sha256}</code>
                          <small>승인 identity</small>
                          <code>{portable.approval_sha256}</code>
                          <div class="alert warning small-alert">
                            현재 Windows 사용자 권한으로 실행됩니다. Job Object는 프로세스 수명 경계이며 OS 수준 네트워크·파일 격리는 아닙니다.
                          </div>
                        </div>
                      )}
                      <dl class="approval-metadata">
                        <div>
                          <dt>서버</dt>
                          <dd>
                            <code>{approval.server || "—"}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>도구</dt>
                          <dd>
                            <code>{approval.tool || "—"}</code>
                          </dd>
                        </div>
                        <div>
                          <dt>명령</dt>
                          <dd>
                            <code>{approval.command || "—"}</code>
                          </dd>
                        </div>
                      </dl>
                      <details class="approval-arguments">
                        <summary>인수 확인</summary>
                        <pre>{approval.arguments_json || "인수가 제공되지 않았습니다."}</pre>
                      </details>
                      <span class="approval-time">{formatDate(approval.created_at)}</span>
                      <div class="approval-actions">
                        <button
                          class="button small"
                          onClick={() => onDecideApproval(approval, "approved")}
                          disabled={busy !== null}
                        >
                          승인
                        </button>
                        <button
                          class="button text small"
                          onClick={() => onDecideApproval(approval, "denied")}
                          disabled={busy !== null}
                        >
                          거절
                        </button>
                      </div>
                    </article>
                    );
                  })}
                </div>
              )}
            </div>

            <div class="summary-section activity-panel">
              <div class="summary-heading">
                <span>연구 활동</span>
                <span class="live-label">
                  <span class="live-dot" />
                  LIVE
                </span>
              </div>
              {events.length === 0 ? (
                <p class="summary-empty">연구를 시작하면 단계별 활동이 표시됩니다.</p>
              ) : (
                <div class="activity-list">
                  {events.slice(0, 6).map((event, index) => (
                    <div
                      class="activity-item"
                      key={`${event.event_id ?? event.sequence ?? event.id ?? "event"}-${index}`}
                    >
                      <span class="activity-dot" />
                      <div>
                        <strong>{runEventLabel(String(event.kind ?? "run_event"))}</strong>
                        <small>{formatDate(event.created_at)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </aside>
  );
}
