import type { Project } from "../types";

export type ProjectDeleteDialogProps = {
  project: Project | null;
  confirmation: string;
  busy: boolean;
  error: string;
  onConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: (event: Event) => void;
};

export function ProjectDeleteDialog({
  project,
  confirmation,
  busy,
  error,
  onConfirmationChange,
  onCancel,
  onConfirm
}: ProjectDeleteDialogProps) {
  if (!project) return null;
  const confirmed = confirmation === project.name;

  return (
    <div class="project-delete-backdrop">
      <section
        class="panel project-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-delete-title"
        aria-describedby="project-delete-description"
      >
        <div class="project-delete-dialog-head">
          <div>
            <p class="eyebrow">Project Deletion</p>
            <h2 id="project-delete-title">“{project.name}” 삭제</h2>
          </div>
          <button
            class="project-delete-close"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="프로젝트 삭제 취소"
          >
            ✕
          </button>
        </div>

        <p id="project-delete-description" class="project-delete-description">
          이 프로젝트의 대화 세션, 연구 실행, 일정, 기억과 지식 그래프를 영구 삭제합니다.
          브라우저 프로필과 다른 프로젝트는 유지됩니다.
        </p>

        <div class="project-delete-warning" role="note">
          진행 중이거나 결과가 불확실한 작업이 있으면 코어가 삭제를 거부합니다.
        </div>

        <form onSubmit={onConfirm}>
          <label for="project-delete-confirmation">
            계속하려면 프로젝트 이름 <strong>{project.name}</strong>을(를) 입력하세요.
          </label>
          <input
            id="project-delete-confirmation"
            value={confirmation}
            onInput={(event) => onConfirmationChange(event.currentTarget.value)}
            autoFocus
            autoComplete="off"
            spellcheck={false}
          />

          {error && (
            <div class="alert danger project-delete-error" role="alert">
              {error}
            </div>
          )}

          <div class="project-delete-dialog-actions">
            <button class="button secondary" type="button" onClick={onCancel} disabled={busy}>
              취소
            </button>
            <button class="button danger" type="submit" disabled={!confirmed || busy}>
              {busy ? "삭제 중…" : "프로젝트 삭제"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
