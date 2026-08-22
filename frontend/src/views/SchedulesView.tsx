import { useMemo, useState } from "preact/hooks";
import type { ConversationSession, Project, Schedule } from "../types";

export type SchedulesViewProps = {
  projects: Project[] | null;
  sessions: ConversationSession[] | null;
  selectedProjectID: string;
  onSelectProjectID: (id: string) => void;
  selectedSessionID: string;
  onSelectSessionID: (id: string) => void;
  schedules: Schedule[] | null;
  coreReady: boolean;
  busy: string | null;
  onCreateSchedule: (data: {
    project_id: string;
    conversation_session_id: string;
    question: string;
    kind: Schedule["kind"];
    expression: string;
    timezone: string;
  }) => Promise<void>;
  onToggleScheduleEnabled?: (scheduleID: string, enabled: boolean) => Promise<void>;
  onDeleteSchedule?: (scheduleID: string) => Promise<void>;
  formatDate: (val: unknown) => string;
};

const INTERVAL_PRESETS = [
  { label: "1시간마다", value: "1h" },
  { label: "3시간마다", value: "3h" },
  { label: "6시간마다", value: "6h" },
  { label: "12시간마다", value: "12h" },
  { label: "24시간마다 (매일)", value: "24h" },
  { label: "48시간마다 (이틀)", value: "48h" }
];

const CRON_PRESETS = [
  { label: "평일 매일 오전 9시", expression: "0 9 * * 1-5", desc: "월~금 아침 09:00" },
  { label: "매일 아침 9시", expression: "0 9 * * *", desc: "매일 아침 09:00" },
  { label: "매주 월요일 아침 9시", expression: "0 9 * * 1", desc: "매주 월요일 09:00" },
  { label: "매일 자정", expression: "0 0 * * *", desc: "매일 밤 00:00" }
];

function describeSchedule(kind: Schedule["kind"], expression: string): string {
  const exp = expression.trim();
  if (kind === "every") {
    if (exp === "1h") return "1시간마다 정기 실행";
    if (exp === "6h") return "6시간마다 정기 실행";
    if (exp === "12h") return "12시간마다 정기 실행";
    if (exp === "24h") return "24시간(1일)마다 정기 실행";
    if (exp === "48h") return "48시간(2일)마다 정기 실행";
    return `${exp} 간격으로 주기적 실행`;
  }
  if (kind === "cron") {
    if (exp === "0 9 * * 1-5") return "평일(월~금) 매일 오전 9:00 정기 실행";
    if (exp === "0 9 * * *") return "매일 오전 9:00 정기 실행";
    if (exp === "0 9 * * 1") return "매주 월요일 오전 9:00 정기 실행";
    if (exp === "0 0 * * *") return "매일 자정(00:00) 정기 실행";
    return `Cron 표현식 [${exp}]에 맞춰 정기 실행`;
  }
  if (kind === "at") {
    return `${exp} 시점에 1회 예약 실행`;
  }
  return expression;
}

function getRelativeTimeStr(dateVal: unknown): string {
  if (!dateVal) return "예정 없음";
  const target = new Date(String(dateVal)).getTime();
  if (isNaN(target)) return "예정 없음";
  const diffMs = target - Date.now();
  if (diffMs < 0) return "실행 대기/완료";
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `약 ${diffMins}분 후`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `약 ${diffHours}시간 후`;
  const diffDays = Math.floor(diffHours / 24);
  return `약 ${diffDays}일 후`;
}

export function SchedulesView({
  projects,
  sessions,
  selectedProjectID,
  onSelectProjectID,
  selectedSessionID,
  onSelectSessionID,
  schedules,
  coreReady,
  busy,
  onCreateSchedule,
  onToggleScheduleEnabled,
  onDeleteSchedule,
  formatDate
}: SchedulesViewProps) {
  const [question, setQuestion] = useState("");
  const [kind, setKind] = useState<Schedule["kind"]>("every");
  const [expression, setExpression] = useState("24h");
  const [timezone, setTimezone] = useState("Asia/Seoul");
  const [searchFilter, setSearchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");

  const selectedProject = projects?.find((p) => p.id === selectedProjectID) ?? null;
  const selectedSession = sessions?.find((s) => s.id === selectedSessionID) ?? null;

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!coreReady || !selectedProjectID || !selectedSessionID || !question.trim()) return;
    await onCreateSchedule({
      project_id: selectedProjectID,
      conversation_session_id: selectedSessionID,
      question: question.trim(),
      kind,
      expression: expression.trim(),
      timezone: timezone.trim() || "Asia/Seoul"
    });
    setQuestion("");
  }

  const filteredSchedules = useMemo(() => {
    if (!schedules) return [];
    return schedules.filter((s) => {
      const matchesStatus =
        statusFilter === "all" || (statusFilter === "enabled" ? s.enabled : !s.enabled);
      const q = searchFilter.toLowerCase().trim();
      const matchesSearch =
        !q ||
        s.question.toLowerCase().includes(q) ||
        s.expression.toLowerCase().includes(q) ||
        s.kind.toLowerCase().includes(q) ||
        (s.timezone && s.timezone.toLowerCase().includes(q));
      return matchesStatus && matchesSearch;
    });
  }, [schedules, statusFilter, searchFilter]);

  const isSubmitting = busy === "schedule-create";

  return (
    <div class="settings-layout schedule-layout" aria-label="연구 일정 화면">
      {/* Left Column: Smart Schedule Creator */}
      <section class="panel setting-card schedule-creator-card">
        <p class="eyebrow">자동 심층 연구</p>
        <h2>새 연구 일정 만들기</h2>
        <p class="schedule-creator-lead">
          프로젝트와 대화를 지정하고 실행 주기를 설정하면 백그라운드 워커가 정기적으로 심층 연구
          파이프라인(PLAN → COLLECT → SYNTHESIZE → REVIEW)을 실행합니다.
        </p>

        <form class="schedule-form" onSubmit={handleSubmit}>
          {/* Target Project & Session */}
          <div class="form-grid-2">
            <div class="schedule-form-group">
              <label for="schedule-project-select">대상 프로젝트</label>
              <select
                id="schedule-project-select"
                value={selectedProjectID}
                onChange={(e) => onSelectProjectID(e.currentTarget.value)}
              >
                {(projects ?? []).map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div class="schedule-form-group">
              <label for="schedule-session-select">실행 대화 세션</label>
              <select
                id="schedule-session-select"
                value={selectedSessionID}
                onChange={(e) => onSelectSessionID(e.currentTarget.value)}
              >
                {(sessions ?? []).map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Research Question */}
          <div class="schedule-form-group">
            <label for="schedule-question-input">반복 실행할 연구 질문 및 목표</label>
            <textarea
              id="schedule-question-input"
              value={question}
              onInput={(e) => setQuestion(e.currentTarget.value)}
              placeholder="예: 최신 경쟁사 릴리스와 주요 오픈소스 저장소 변경점을 종합하여 분석 보고서 작성"
              rows={3}
            />
          </div>

          {/* Cadence Kind Tabs */}
          <div class="cadence-builder-section">
            <div class="cadence-tabs-row">
              <span class="cadence-label">실행 주기 모드:</span>
              <div class="cadence-tabs">
                <button
                  type="button"
                  class={`cadence-tab ${kind === "every" ? "active" : ""}`}
                  onClick={() => {
                    setKind("every");
                    setExpression("24h");
                  }}
                >
                  시간 간격 (Every)
                </button>
                <button
                  type="button"
                  class={`cadence-tab ${kind === "cron" ? "active" : ""}`}
                  onClick={() => {
                    setKind("cron");
                    setExpression("0 9 * * 1-5");
                  }}
                >
                  Cron 정기 예약 (Cron)
                </button>
                <button
                  type="button"
                  class={`cadence-tab ${kind === "at" ? "active" : ""}`}
                  onClick={() => {
                    setKind("at");
                    setExpression(new Date(Date.now() + 86400000).toISOString().slice(0, 19));
                  }}
                >
                  1회성 예약 (At)
                </button>
              </div>
            </div>

            {/* Interval Presets */}
            {kind === "every" && (
              <div class="schedule-presets-row">
                <span>빠른 간격:</span>
                {INTERVAL_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.value}
                    class={`preset-chip ${expression === p.value ? "active" : ""}`}
                    onClick={() => setExpression(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {/* Cron Presets */}
            {kind === "cron" && (
              <div class="schedule-presets-row">
                <span>빠른 Cron:</span>
                {CRON_PRESETS.map((p) => (
                  <button
                    type="button"
                    key={p.expression}
                    class={`preset-chip ${expression === p.expression ? "active" : ""}`}
                    onClick={() => setExpression(p.expression)}
                  >
                    {p.label} ({p.desc})
                  </button>
                ))}
              </div>
            )}

            {/* Custom Input & Timezone */}
            <div class="schedule-fields-row">
              <div class="schedule-field-item">
                <label for="schedule-expression-input">
                  {kind === "every"
                    ? "간격 표현식 (예: 6h, 24h, 30m)"
                    : kind === "cron"
                    ? "Cron 표현식 (분 시 일 월 요일)"
                    : "지정 실행 일시 (ISO 형식)"}
                </label>
                <input
                  id="schedule-expression-input"
                  value={expression}
                  onInput={(e) => setExpression(e.currentTarget.value)}
                  placeholder={
                    kind === "at"
                      ? "2026-09-01T09:00:00"
                      : kind === "cron"
                      ? "0 9 * * 1-5"
                      : "24h"
                  }
                />
              </div>

              <div class="schedule-field-item">
                <label for="schedule-timezone-input">적용 시간대</label>
                <input
                  id="schedule-timezone-input"
                  value={timezone}
                  onInput={(e) => setTimezone(e.currentTarget.value)}
                  placeholder="Asia/Seoul"
                />
              </div>
            </div>

            {/* Real-time Schedule Description Preview */}
            <div class="schedule-preview-box">
              <span class="preview-label">실행 설명 미리보기:</span>
              <strong class="preview-text">{describeSchedule(kind, expression)}</strong>
              <small class="preview-tz">({timezone || "Asia/Seoul"} 기준)</small>
            </div>
          </div>

          <div class="schedule-submit-row">
            <span class="schedule-hint">
              {selectedSession
                ? `대화 "${selectedSession.title}"에서 자동 실행됩니다.`
                : "대화를 먼저 선택해 주세요."}
            </span>
            <button
              class="button"
              type="submit"
              disabled={
                isSubmitting ||
                !selectedProjectID ||
                !selectedSessionID ||
                !question.trim() ||
                !coreReady
              }
            >
              {isSubmitting ? "일정 등록 중…" : "연구 일정 등록"}
            </button>
          </div>
        </form>
      </section>

      {/* Right Column: Registered Schedules List & Controls */}
      <section class="panel setting-card schedule-list-card">
        <div class="panel-heading schedule-list-heading">
          <div>
            <p class="eyebrow">등록된 자동화 파이프라인</p>
            <h2>연구 일정 목록 ({filteredSchedules.length}/{schedules?.length ?? 0})</h2>
          </div>
          <span class="count-badge">{schedules?.length ?? 0}</span>
        </div>

        {/* Filter Toolbar */}
        <div class="schedule-filter-bar">
          <input
            type="search"
            class="schedule-search-input"
            placeholder="연구 질문, 주기, 시간대 검색…"
            value={searchFilter}
            onInput={(e) => setSearchFilter(e.currentTarget.value)}
          />

          <div class="schedule-filter-chips">
            <button
              type="button"
              class={`filter-chip ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              전체
            </button>
            <button
              type="button"
              class={`filter-chip ${statusFilter === "enabled" ? "active" : ""}`}
              onClick={() => setStatusFilter("enabled")}
            >
              활성 ({schedules?.filter((s) => s.enabled).length ?? 0})
            </button>
            <button
              type="button"
              class={`filter-chip ${statusFilter === "disabled" ? "active" : ""}`}
              onClick={() => setStatusFilter("disabled")}
            >
              일시 중지 ({schedules?.filter((s) => !s.enabled).length ?? 0})
            </button>
          </div>
        </div>

        {schedules === null ? (
          <div class="empty-state">
            <strong>일정 목록을 불러오는 중입니다…</strong>
          </div>
        ) : filteredSchedules.length === 0 ? (
          <div class="empty-state">
            <strong>
              {searchFilter || statusFilter !== "all"
                ? "조건에 일치하는 일정이 없습니다."
                : "등록된 연구 일정이 없습니다."}
            </strong>
            <span>왼쪽 양식에서 정기적으로 실행할 새 연구 일정을 등록해 보세요.</span>
          </div>
        ) : (
          <div class="schedule-list">
            {filteredSchedules.map((s) => {
              const isItemBusy = busy === `schedule-toggle-${s.id}` || busy === `schedule-delete-${s.id}`;
              const relativeNext = getRelativeTimeStr(s.next_run_at);

              return (
                <article class={`schedule-item-card ${s.enabled ? "enabled" : "disabled"}`} key={s.id}>
                  <div class="schedule-item-head">
                    <div class="schedule-badges-row">
                      <span class="schedule-kind-badge">{s.kind.toUpperCase()}</span>
                      <span class={`schedule-status-badge ${s.enabled ? "enabled" : "disabled"}`}>
                        {s.enabled ? "✓ 활성" : "일시 중지"}
                      </span>
                    </div>

                    <div class="schedule-item-actions">
                      {onToggleScheduleEnabled && (
                        <button
                          type="button"
                          class="button secondary small"
                          disabled={isItemBusy}
                          onClick={() => onToggleScheduleEnabled(s.id, !s.enabled)}
                        >
                          {s.enabled ? "일시 중지" : "다시 시작"}
                        </button>
                      )}

                      {onDeleteSchedule && (
                        <button
                          type="button"
                          class="button danger small"
                          disabled={isItemBusy}
                          onClick={() => {
                            if (window.confirm("이 연구 일정을 영구적으로 삭제할까요?")) {
                              void onDeleteSchedule(s.id);
                            }
                          }}
                        >
                          삭제
                        </button>
                      )}
                    </div>
                  </div>

                  <strong class="schedule-question-text">{s.question}</strong>

                  <p class="schedule-description-line">
                    • {describeSchedule(s.kind, s.expression)}
                  </p>

                  <div class="schedule-meta-grid">
                    <div>
                      <span>주기 표현식</span>
                      <code>{s.expression}</code>
                    </div>
                    <div>
                      <span>적용 시간대</span>
                      <code>{s.timezone || "Asia/Seoul"}</code>
                    </div>
                    <div>
                      <span>다음 실행</span>
                      <strong class="next-run-text">
                        {formatDate(s.next_run_at)} ({relativeNext})
                      </strong>
                    </div>
                    <div>
                      <span>마지막 실행</span>
                      <span>{s.last_run_at ? formatDate(s.last_run_at) : "기록 없음"}</span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
