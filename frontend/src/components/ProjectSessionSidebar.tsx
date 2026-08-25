import { useState } from "preact/hooks";
import type { Connection, ConversationSession, Project, View } from "../types";

export type ProjectSessionSidebarProps = {
  view: View;
  onSetView: (v: View) => void;
  projects: Project[] | null;
  selectedProjectID: string;
  onSelectProject: (id: string) => void;
  sessions: ConversationSession[] | null;
  selectedSessionID: string;
  onSelectSession: (id: string) => void;
  connection: Connection;
  busy: string | null;
  busySessions: Record<string, boolean>;
  collapsedProjectIDs: string[];
  onToggleProjectCollapse: (id: string) => void;
  newProjectName: string;
  onNewProjectNameChange: (name: string) => void;
  onCreateProject: (e: Event) => void;
  onCreateSession: () => void;
  renamingProjectID: string;
  projectNameDraft: string;
  onProjectNameDraftChange: (name: string) => void;
  onBeginRenameProject: (p: Project) => void;
  onRenameProject: (id: string) => void;
  onCancelRenameProject: () => void;
  onDeleteProject: (p: Project) => void;
  renamingSessionID: string;
  sessionTitleDraft: string;
  onSessionTitleDraftChange: (title: string) => void;
  onBeginRenameSession: (s: ConversationSession) => void;
  onRenameSession: (id: string) => void;
  onCancelRenameSession: () => void;
  onDeleteSession: (s: ConversationSession) => void;
};

export function ProjectSessionSidebar({
  view,
  onSetView,
  projects,
  selectedProjectID,
  onSelectProject,
  sessions,
  selectedSessionID,
  onSelectSession,
  connection,
  busy,
  collapsedProjectIDs,
  onToggleProjectCollapse,
  newProjectName,
  onNewProjectNameChange,
  onCreateProject,
  onCreateSession,
  renamingProjectID,
  projectNameDraft,
  onProjectNameDraftChange,
  onBeginRenameProject,
  onRenameProject,
  onCancelRenameProject,
  onDeleteProject,
  renamingSessionID,
  sessionTitleDraft,
  onSessionTitleDraftChange,
  onBeginRenameSession,
  onRenameSession,
  onCancelRenameSession,
  onDeleteSession
}: ProjectSessionSidebarProps) {
  const [filterQuery, setFilterQuery] = useState("");

  const filteredSessions = sessions?.filter((s) =>
    s.title.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <aside class="sidebar">
      {/* Brand Header */}
      <button type="button" class="brand" onClick={() => onSetView("workspace")}>
        <span class="brand-mark"><img src="/aetherops-icon.png" alt="" /></span>
        <div>
          <strong>AetherOps</strong>
          <small>데스크톱 워크스페이스</small>
        </div>
        <span class="brand-chevron">›</span>
      </button>

      {/* New Chat Primary Action */}
      <button
        class="sidebar-new-chat"
        type="button"
        onClick={onCreateSession}
        disabled={!selectedProjectID || busy !== null}
      >
        <span>+</span>
        <strong>새 대화</strong>
        <kbd>Ctrl+N</kbd>
      </button>

      {/* Primary View Navigation Shortcuts (No emojis) */}
      <nav class="sidebar-shortcuts" aria-label="주요 화면">
        <button
          class={view === "workspace" ? "nav-item active" : "nav-item"}
          onClick={() => onSetView("workspace")}
        >
          <span>•</span> 대화 및 연구
        </button>
        <button
          class={view === "knowledge" ? "nav-item active" : "nav-item"}
          onClick={() => onSetView("knowledge")}
        >
          <span>•</span> 프로젝트 지식
        </button>
        <button
          class={view === "tools" ? "nav-item active" : "nav-item"}
          onClick={() => onSetView("tools")}
        >
          <span>•</span> Tool Studio
        </button>
        <button
          class={view === "artifacts" ? "nav-item active" : "nav-item"}
          onClick={() => onSetView("artifacts")}
        >
          <span>•</span> 산출물
        </button>
        <button
          class={view === "schedules" ? "nav-item active" : "nav-item"}
          onClick={() => onSetView("schedules")}
        >
          <span>•</span> 연구 일정
        </button>
        <button
          class={view === "controls" ? "nav-item active" : "nav-item"}
          onClick={() => onSetView("controls")}
        >
          <span>•</span> 브라우저 제어
        </button>
      </nav>

      {/* Project & Session Tree */}
      <section class="sidebar-project-tree" aria-label="프로젝트 및 대화 목록">
        <div class="sidebar-section-heading">
          <span>프로젝트</span>
          <span>{projects?.length ?? 0}</span>
        </div>

        <form class="sidebar-project-form" onSubmit={onCreateProject}>
          <input
            type="text"
            placeholder="+ 새 프로젝트"
            value={newProjectName}
            onInput={(e) => onNewProjectNameChange(e.currentTarget.value)}
            disabled={busy !== null}
          />
          <button
            class="button"
            type="submit"
            disabled={busy !== null || !newProjectName.trim()}
            aria-label="프로젝트 추가"
          >
            +
          </button>
        </form>

        {/* Quick Filter Box */}
        {(sessions?.length ?? 0) > 4 && (
          <div class="sidebar-filter-box">
            <input
              type="search"
              class="sidebar-filter-input"
              placeholder="대화 검색…"
              value={filterQuery}
              onInput={(e) => setFilterQuery(e.currentTarget.value)}
              aria-label="대화 검색"
            />
          </div>
        )}

        <div class="project-tree-list">
          {(projects ?? []).map((project) => {
            const isSelected = project.id === selectedProjectID;
            const isCollapsed = collapsedProjectIDs.includes(project.id);
            const isRenaming = renamingProjectID === project.id;

            return (
              <div key={project.id} class={isSelected ? "tree-project selected" : "tree-project"}>
                <div class="tree-project-row">
                  {isRenaming ? (
                    <div class="project-rename">
                      <input
                        type="text"
                        value={projectNameDraft}
                        onInput={(e) => onProjectNameDraftChange(e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        onClick={() => onRenameProject(project.id)}
                        disabled={busy !== null || !projectNameDraft.trim()}
                      >
                        저장
                      </button>
                      <button type="button" onClick={onCancelRenameProject}>
                        취소
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        class="tree-project-select"
                        onClick={() => onSelectProject(project.id)}
                      >
                        <span
                          class="tree-disclosure"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleProjectCollapse(project.id);
                          }}
                        >
                          {isCollapsed ? "›" : "⌄"}
                        </span>
                        <span class="tree-folder-icon" />
                        <strong>{project.name}</strong>
                      </button>
                      <button
                        type="button"
                        class="tree-action"
                        onClick={() => onBeginRenameProject(project)}
                        title="프로젝트 이름 변경"
                        aria-label="프로젝트 이름 변경"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        class="tree-action danger"
                        onClick={() => onDeleteProject(project)}
                        disabled={busy !== null || connection !== "connected"}
                        title="프로젝트 삭제"
                        aria-label={`${project.name} 삭제`}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>

                {!isCollapsed && isSelected && (
                  <div class="tree-sessions">
                    <div class="tree-session-heading">
                      <span>대화</span>
                      <button
                        type="button"
                        onClick={onCreateSession}
                        disabled={busy !== null}
                        title="새 대화 만들기"
                        aria-label="새 대화 만들기"
                      >
                        +
                      </button>
                    </div>
                    {sessions === null ? (
                      <span class="tree-placeholder nested">대화 목록을 불러오는 중…</span>
                    ) : (filteredSessions?.length ?? 0) === 0 ? (
                      <span class="tree-placeholder nested">
                        {filterQuery ? "일치하는 대화 없음" : "대화가 없습니다."}
                      </span>
                    ) : (
                      filteredSessions?.map((session) => {
                        const isSessionSelected = session.id === selectedSessionID;
                        const isSessionRenaming = renamingSessionID === session.id;

                        return (
                          <div
                            key={session.id}
                            class={isSessionSelected ? "tree-session selected" : "tree-session"}
                          >
                            {isSessionRenaming ? (
                              <div class="session-rename">
                                <input
                                  type="text"
                                  value={sessionTitleDraft}
                                  onInput={(e) => onSessionTitleDraftChange(e.currentTarget.value)}
                                />
                                <button
                                  type="button"
                                  onClick={() => onRenameSession(session.id)}
                                  disabled={busy !== null || !sessionTitleDraft.trim()}
                                >
                                  저장
                                </button>
                                <button type="button" onClick={onCancelRenameSession}>
                                  취소
                                </button>
                              </div>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  class="tree-session-select"
                                  onClick={() => onSelectSession(session.id)}
                                >
                                  <span class="tree-session-glyph" />
                                  <span>
                                    <strong>{session.title}</strong>
                                  </span>
                                </button>
                                <div class="tree-session-actions">
                                  <button
                                    type="button"
                                    onClick={() => onBeginRenameSession(session)}
                                    title="대화 제목 변경"
                                    aria-label="대화 제목 변경"
                                  >
                                    ✎
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => onDeleteSession(session)}
                                    title="대화 삭제"
                                    aria-label="대화 삭제"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer Navigation & Connection */}
      <div class="sidebar-bottom">
        <button
          class={view === "settings" ? "sidebar-settings active" : "sidebar-settings"}
          type="button"
          onClick={() => onSetView("settings")}
        >
          <span>⚙</span>
          <strong>설정</strong>
        </button>
        <div class="sidebar-footer">
          <span class={`connection-dot ${connection}`} />
          <span>{connection === "connected" ? "코어 연결됨" : "확인 중"}</span>
        </div>
      </div>
    </aside>
  );
}
