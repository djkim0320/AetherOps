import { useCallback, useEffect, useState } from "preact/hooks";
import { del, formatApiError, get, listFrom, objectFrom, post } from "./api";
import { canReindexMemory, memoryStateLabel, type ProjectMemoryStatus } from "./memory-status";

export type LifecycleProject = {
  id: string;
  name: string;
};

type MemoryDocument = {
  id: string;
  title: string;
  media_type?: string;
  size?: number;
  pinned?: boolean;
  graph_adopt?: boolean;
  knowledge_references?: number;
};

type LifecycleControlsProps = {
  project: LifecycleProject | null;
  connected: boolean;
  onProjectDeleted: (casCleanupPending: number) => void | Promise<void>;
};

function bytesLabel(value: number | undefined): string {
  if (!Number.isFinite(value) || value === undefined || value < 0) return "크기 미상";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export function LifecycleControls({ project, connected, onProjectDeleted }: LifecycleControlsProps) {
  const [memory, setMemory] = useState<MemoryDocument[] | null>(null);
  const [memoryStatus, setMemoryStatus] = useState<ProjectMemoryStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshMemory = useCallback(async () => {
    if (!connected || !project) {
      setMemory([]);
      setMemoryStatus(null);
      return;
    }
    setMemory(null);
    try {
      const [documentsPayload, statusPayload] = await Promise.all([
        get<unknown>(`/api/v1/projects/${encodeURIComponent(project.id)}/memory`),
        get<unknown>(`/api/v1/projects/${encodeURIComponent(project.id)}/memory/status`)
      ]);
      setMemory(listFrom<MemoryDocument>(documentsPayload, "memory"));
      setMemoryStatus(objectFrom(statusPayload, "memory") as ProjectMemoryStatus | null);
    } catch (cause) {
      setMemory([]);
      setMemoryStatus(null);
      setError(formatApiError(cause));
    }
  }, [connected, project?.id]);

  useEffect(() => {
    setError("");
    setNotice("");
    void refreshMemory();
  }, [refreshMemory]);

  async function forgetMemory(document: MemoryDocument) {
    if (!project || busy) return;
    const confirmation = window.prompt(`이 항목을 RAG 기억에서 제거하려면 정확한 제목을 입력하세요:\n${document.title}`);
    if (confirmation === null) return;
    if (confirmation !== document.title) {
      setError("제목이 일치하지 않아 기억을 제거하지 않았습니다.");
      return;
    }
    setBusy(`memory-${document.id}`);
    setError("");
    setNotice("");
    try {
      const payload = await del<unknown>(
        `/api/v1/projects/${encodeURIComponent(project.id)}/memory/${encodeURIComponent(document.id)}`,
        { document_id: document.id, confirm_title: confirmation }
      );
      const result = objectFrom(payload);
      if (result?.cas_cleanup_pending === true) {
        setNotice("기억은 제거했습니다. CAS 파일 정리는 완료되지 않아 다음 AetherOps 시작 때 안전하게 재시도합니다.");
      } else if (result?.knowledge_graph_stale === true) {
        setNotice("기억에서 제거했습니다. 그래프 채택 자료였으므로 Knowledge 화면에서 재구축해야 연구를 다시 시작할 수 있습니다.");
      } else if (result?.retained_for_graph_provenance === true) {
        setNotice("RAG 검색에서는 제거했습니다. 검증된 기존 그래프의 근거 보존본은 유지됩니다.");
      } else {
        setNotice(result?.cas_object_removed === true
          ? "기억과 참조되지 않는 CAS 객체를 제거했습니다."
          : "기억을 제거했습니다. 공유되거나 채택된 원본 CAS 객체는 보존했습니다.");
      }
      await refreshMemory();
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function reindexMemory() {
    if (!project || busy || !canReindexMemory(memoryStatus) || !memory?.length) return;
    setBusy("memory-reindex");
    setError("");
    setNotice("");
    try {
      const payload = await post<unknown>(
        `/api/v1/projects/${encodeURIComponent(project.id)}/memory/reindex`
      );
      setMemoryStatus(objectFrom(payload, "memory") as ProjectMemoryStatus | null);
      setNotice("검증된 shadow index를 활성화했습니다. 기존 index는 원자적으로 교체되었습니다.");
      await refreshMemory();
    } catch (cause) {
      setError(formatApiError(cause));
      await refreshMemory();
    } finally {
      setBusy("");
    }
  }

  async function resetBrowserProfile() {
    if (!connected || busy) return;
    const phrase = "RESET INTERNET PROFILE";
    const confirmation = window.prompt(
      `AetherOps 인터넷 브라우저의 로그인·쿠키·사이트 데이터만 초기화합니다.\n` +
      `셸 UI, 프로젝트, CAS, Codex 로그인은 삭제하지 않습니다.\n\n계속하려면 ${phrase} 을(를) 입력하세요.`
    );
    if (confirmation === null) return;
    if (confirmation !== phrase) {
      setError("확인 문구가 일치하지 않아 브라우저 프로필을 초기화하지 않았습니다.");
      return;
    }
    setBusy("profile-reset");
    setError("");
    setNotice("");
    try {
      await post<unknown>("/api/v1/browser/profile-reset", { confirmation });
      setNotice("브라우저 자동화를 중지하고 초기화를 예약했습니다. AetherOps를 완전히 종료한 뒤 다시 시작하면 인터넷 프로필만 재생성됩니다.");
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  async function deleteProject() {
    if (!project || busy) return;
    const confirmation = window.prompt(
      `프로젝트와 그 실행·기억·그래프를 영구 삭제합니다.\n` +
      `브라우저 프로필과 다른 프로젝트는 유지됩니다.\n\n계속하려면 정확한 프로젝트 이름을 입력하세요:\n${project.name}`
    );
    if (confirmation === null) return;
    if (confirmation !== project.name) {
      setError("프로젝트 이름이 일치하지 않아 삭제하지 않았습니다.");
      return;
    }
    setBusy("project-delete");
    setError("");
    setNotice("");
    try {
      const payload = await del<unknown>(`/api/v1/projects/${encodeURIComponent(project.id)}`, {
        project_id: project.id,
        confirm_name: confirmation
      });
      const result = objectFrom(payload);
      const cleanupPending = typeof result?.cas_cleanup_pending === "number" ? result.cas_cleanup_pending : 0;
      await onProjectDeleted(cleanupPending);
    } catch (cause) {
      setError(formatApiError(cause));
    } finally {
      setBusy("");
    }
  }

  return <>
    {(error || notice) && <section class={`panel lifecycle-message ${error ? "danger" : "success"}`} role={error ? "alert" : "status"}>{error || notice}</section>}

    <section class="panel setting-card lifecycle-card">
      <p class="eyebrow">개별 기억 관리</p>
      <div class="lifecycle-title-row"><h2>RAG 기억</h2><div class="lifecycle-title-actions"><button class="button secondary small" type="button" onClick={() => void refreshMemory()} disabled={!connected || Boolean(busy)}>새로 고침</button><button class="button secondary small" type="button" onClick={() => void reindexMemory()} disabled={!connected || Boolean(busy) || !canReindexMemory(memoryStatus) || !memory?.length}>{busy === "memory-reindex" ? "재색인 중" : "Shadow 재색인"}</button></div></div>
      <p>선택한 프로젝트의 검색 기억만 개별 제거합니다. 그래프가 참조하는 근거는 검증 이력을 위해 보존될 수 있습니다.</p>
      <div class={`lifecycle-memory-status ${memoryStatus?.state ?? "loading"}`} aria-live="polite">
        <strong>{memoryStateLabel(memoryStatus)}</strong>
        <span>revision {memoryStatus?.memory_revision ?? "–"}</span>
        {memoryStatus?.active_index ? <span>{memoryStatus.active_index.model} · {memoryStatus.active_index.dimensions}차원</span> : <span>활성 index 없음</span>}
        {memoryStatus?.error ? <small>{memoryStatus.error}</small> : null}
      </div>
      {!project ? <p class="muted">먼저 프로젝트를 선택하세요.</p>
        : memory === null ? <p class="muted">기억 목록을 불러오는 중입니다.</p>
        : memory.length === 0 ? <p class="muted">삭제할 수 있는 활성 기억이 없습니다.</p>
        : <div class="lifecycle-memory-list">{memory.map((document) => <article key={document.id}>
            <div><strong>{document.title}</strong><span>{document.media_type || "unknown"} · {bytesLabel(document.size)}</span><small>{document.pinned ? "사용자 고정" : "성공 연구 채택"}{document.graph_adopt ? " · 그래프 채택" : ""}{document.knowledge_references ? ` · 근거 참조 ${document.knowledge_references}` : ""}</small></div>
            <button class="button danger-outline small" type="button" onClick={() => void forgetMemory(document)} disabled={Boolean(busy)}>{busy === `memory-${document.id}` ? "제거 중" : "기억에서 제거"}</button>
          </article>)}</div>}
    </section>

    <section class="panel setting-card lifecycle-card">
      <p class="eyebrow">격리 브라우저</p><h2>인터넷 프로필 초기화</h2>
      <p>자동화를 즉시 멈춘 뒤 다음 시작 때 <code>webview2\internet</code>만 삭제·재생성합니다. 프로젝트 데이터와 셸 프로필은 건드리지 않습니다.</p>
      <button class="button danger-outline" type="button" onClick={() => void resetBrowserProfile()} disabled={!connected || Boolean(busy)}>{busy === "profile-reset" ? "초기화 예약 중" : "인터넷 프로필 초기화"}</button>
    </section>

    <section class="panel setting-card lifecycle-card lifecycle-danger-zone">
      <p class="eyebrow">위험 구역</p><h2>프로젝트 삭제</h2>
      <p>{project ? <><strong>{project.name}</strong>의 실행, 일정, 기억, 그래프와 참조되지 않는 CAS 객체를 제거합니다. 실행·승인·세션 생성·해석·기억 색인·그래프 재구성이 진행 중이거나 결과가 불확실하면 서버가 삭제를 거부합니다.</> : "삭제할 프로젝트를 먼저 선택하세요."}</p>
      <button class="button danger" type="button" onClick={() => void deleteProject()} disabled={!connected || !project || Boolean(busy)}>{busy === "project-delete" ? "삭제 중" : "선택한 프로젝트 삭제"}</button>
    </section>
  </>;
}
