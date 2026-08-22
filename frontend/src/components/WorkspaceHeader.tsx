import type { ConversationSession, Project, View } from "../types";

export type WorkspaceHeaderProps = {
  view: View;
  selectedProject: Project | null;
  selectedSession: ConversationSession | null;
  busy: string | null;
  onRefresh: () => void;
};

export function WorkspaceHeader({
  view,
  selectedProject,
  selectedSession,
  busy,
  onRefresh
}: WorkspaceHeaderProps) {
  const isWorkspace = view === "workspace";

  function viewTitle(): string {
    switch (view) {
      case "workspace":
        return selectedSession?.title || "대화 선택 필요";
      case "knowledge":
        return "프로젝트 지식";
      case "tools":
        return "Tool Studio";
      case "artifacts":
        return "연구 산출물";
      case "schedules":
        return "연구 일정";
      case "controls":
        return "브라우저 제어";
      case "settings":
        return "설정";
      default:
        return "AetherOps";
    }
  }

  function viewEyebrow(): string {
    if (isWorkspace) {
      return selectedProject?.name || "프로젝트 선택 필요";
    }
    return "AetherOps 데스크톱";
  }

  return (
    <header class={isWorkspace ? "topbar workspace-topbar" : "topbar"}>
      <div>
        <p class="eyebrow">{viewEyebrow()}</p>
        <h1>{viewTitle()}</h1>
      </div>
      <button
        class="button secondary refresh-button"
        onClick={onRefresh}
        disabled={busy === "refresh"}
        aria-label="새로 고침"
      >
        <span>{busy === "refresh" ? "…" : "↻"}</span>
        <span>{busy === "refresh" ? "새로 고치는 중" : "새로 고침"}</span>
      </button>
    </header>
  );
}
