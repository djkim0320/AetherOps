import { render } from "preact";
import { lazy, Suspense } from "preact/compat";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  fetchArtifact,
  formatApiError,
  del,
  get,
  listFrom,
  objectFrom,
  patch,
  post,
  subscribeToRunEvents,
  type ArtifactResponse,
  type RunEvent
} from "./api";
import { shouldRefreshApprovals } from "./approval-events";
import { artifactContentPath } from "./artifact-path";
import { artifactPresentation } from "./artifact-presentation";
import { chatHistoryMessages } from "./chat-history";
import { LifecycleControls } from "./LifecycleControls";
import { resolveRunSelection } from "./model-selection";
import { planningObjective } from "./plan-cycle";
import { blockingRunFrom, type RunControlRef } from "./run-controls";
import type {
  Approval,
  Artifact,
  ChatMessage,
  ChatMode,
  ChatReply,
  CodexAccountStatus,
  Connection,
  ContextProfile,
  ContextWindowUsage,
  ConversationPlanCycle,
  ConversationSession,
  JsonRecord,
  ModelOption,
  PlanSelection,
  Project,
  Run,
  Schedule,
  Speed,
  Stage,
  View
} from "./types";
import { STATUS_LABELS } from "./types";

import { ArtifactDrawer } from "./components/ArtifactDrawer";
import { ChatComposer } from "./components/ChatComposer";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { FormattedMessage } from "./components/FormattedMessage";
import { ProjectSessionSidebar } from "./components/ProjectSessionSidebar";
import { ResearchSummaryRail } from "./components/ResearchSummaryRail";
import { WorkspaceHeader } from "./components/WorkspaceHeader";

import { ArtifactsView } from "./views/ArtifactsView";
import { ControlsView } from "./views/ControlsView";
import { SchedulesView } from "./views/SchedulesView";
import { SettingsView } from "./views/SettingsView";

import "./styles.css";

const KnowledgeView = lazy(async () => {
  const module = await import("./KnowledgeView");
  return { default: module.KnowledgeView };
});

const ToolStudioView = lazy(async () => {
  const module = await import("./ToolStudioView");
  return { default: module.ToolStudioView };
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstText(source: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const text = stringValue(source[key]);
    if (text) return text;
  }
  return undefined;
}

function savedPreference(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(`aetherops.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(`aetherops.${key}`, value);
  } catch {
    // blocked WebView storage fallback
  }
}

function modelOptionsFrom(status: JsonRecord | null): ModelOption[] {
  const raw = status?.model_options;
  if (!Array.isArray(raw)) return [];
  const options: ModelOption[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    if (!id) continue;
    const efforts = Array.isArray(item.supported_reasoning_efforts)
      ? item.supported_reasoning_efforts.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    const speeds = Array.isArray(item.supported_speeds)
      ? item.supported_speeds.filter((v): v is Speed => v === "standard" || v === "fast")
      : (["standard"] as Speed[]);
    options.push({
      id,
      display_name: stringValue(item.display_name) ?? id,
      default_reasoning_effort: stringValue(item.default_reasoning_effort) ?? efforts[0] ?? "",
      supported_reasoning_efforts: efforts,
      supported_speeds: speeds.includes("standard") ? speeds : ["standard", ...speeds]
    });
  }
  return options;
}

function formatDate(value: unknown): string {
  const text = stringValue(value);
  if (!text) return "기록 없음";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function limitText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function contextUsageFrom(payload: unknown): ContextWindowUsage {
  const source = isRecord(payload) ? payload : {};
  return {
    available: source.available === true,
    thread_id: stringValue(source.thread_id),
    turn_id: stringValue(source.turn_id),
    current_tokens: numberValue(source.current_tokens) ?? 0,
    context_window: numberValue(source.context_window) ?? 0,
    input_tokens: numberValue(source.input_tokens) ?? 0,
    cached_input_tokens: numberValue(source.cached_input_tokens) ?? 0,
    output_tokens: numberValue(source.output_tokens) ?? 0,
    reasoning_output_tokens: numberValue(source.reasoning_output_tokens) ?? 0,
    used_percent: numberValue(source.used_percent) ?? 0,
    updated_at: stringValue(source.updated_at)
  };
}

function currentStage(run: Run | null): Stage | null {
  if (!run) return null;
  const explicit = stringValue(run.current_stage);
  if (explicit === "plan" || explicit === "collect" || explicit === "synthesize" || explicit === "review") {
    return explicit;
  }
  switch (run.status) {
    case "planning":
      return "plan";
    case "collecting":
      return "collect";
    case "synthesizing":
      return "synthesize";
    case "reviewing":
    case "revising":
    case "waiting_approval":
      return "review";
    default:
      return null;
  }
}

function stageState(stage: Stage, run: Run | null): "complete" | "active" | "waiting" | "attention" {
  if (!run) return "waiting";
  if (run.status === "failed" || run.status === "quality_failed" || run.status === "cancelled") {
    return currentStage(run) === stage ? "attention" : "waiting";
  }
  const stages: Stage[] = ["plan", "collect", "synthesize", "review"];
  const active = currentStage(run);
  if (!active) {
    return run.status === "succeeded" ? "complete" : "waiting";
  }
  const activeIndex = stages.indexOf(active);
  const targetIndex = stages.indexOf(stage);
  if (targetIndex < activeIndex) return "complete";
  if (targetIndex === activeIndex) {
    return run.status === "waiting_approval" ? "waiting" : "active";
  }
  return "waiting";
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div class="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function ArtifactPayloadView({ payload }: { payload: unknown }) {
  if (isRecord(payload) && payload.mime_type && typeof payload.mime_type === "string") {
    return (
      <div class="binary-artifact-card">
        <div class="binary-artifact-icon">DATA</div>
        <div class="binary-artifact-info">
          <strong>{stringValue(payload.name) ?? "바이너리 산출물"}</strong>
          <span>{String(payload.mime_type)}</span>
        </div>
      </div>
    );
  }
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return <FormattedMessage text={text} />;
}

export function App() {
  const [view, setView] = useState<View>("workspace");
  const [connection, setConnection] = useState<Connection>("checking");
  const [status, setStatus] = useState<JsonRecord | null>(null);
  const [runtimeUpdate, setRuntimeUpdate] = useState<JsonRecord | null>(null);
  const [codexAccount, setCodexAccount] = useState<CodexAccountStatus | null>(null);
  const [deviceCode, setDeviceCode] = useState<JsonRecord | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedProjectID, setSelectedProjectID] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [renamingProjectID, setRenamingProjectID] = useState<string>("");
  const [projectNameDraft, setProjectNameDraft] = useState<string>("");
  const [collapsedProjectIDs, setCollapsedProjectIDs] = useState<string[]>([]);
  const [sessions, setSessions] = useState<ConversationSession[] | null>(null);
  const [selectedSessionID, setSelectedSessionID] = useState<string>("");
  const [renamingSessionID, setRenamingSessionID] = useState<string>("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState<string>("");
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, string>>({});
  const [sessionChats, setSessionChats] = useState<Record<string, ChatMessage[]>>({});
  const [sessionChatModes, setSessionChatModes] = useState<Record<string, ChatMode>>({});
  const [planSelections, setPlanSelections] = useState<Record<string, Record<string, PlanSelection>>>({});
  const [submittedPlanQuestions, setSubmittedPlanQuestions] = useState<Record<string, boolean>>({});
  const [planCycles, setPlanCycles] = useState<Record<string, ConversationPlanCycle | null>>({});
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [selectedRunID, setSelectedRunID] = useState<string>("");
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [selectedArtifactID, setSelectedArtifactID] = useState<string>("");
  const [artifactContent, setArtifactContent] = useState<unknown>(null);
  const [drawerArtifact, setDrawerArtifact] = useState<Artifact | null>(null);
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [contextUsages, setContextUsages] = useState<Record<string, ContextWindowUsage>>({});
  const [browserState, setBrowserState] = useState<string | null>(null);
  const [browserMode, setBrowserMode] = useState<"automatic" | "manual" | null>(null);
  const [apiKey, setApiKey] = useState<string>("");
  const [scheduleQuestion, setScheduleQuestion] = useState<string>("");
  const [scheduleKind, setScheduleKind] = useState<Schedule["kind"]>("every");
  const [scheduleExpression, setScheduleExpression] = useState<string>("24h");
  const [scheduleTimezone, setScheduleTimezone] = useState<string>("Asia/Seoul");
  const [busy, setBusy] = useState<string | null>(null);
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [eventIssue, setEventIssue] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [contextDetailsOpen, setContextDetailsOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");

  const modelOptions = useMemo(() => modelOptionsFrom(status), [status]);
  const [selectedModel, setSelectedModel] = useState<string>(() => savedPreference("model", ""));
  const [selectedEffort, setSelectedEffort] = useState<string>(() => savedPreference("effort", "medium"));
  const [selectedSpeed, setSelectedSpeed] = useState<Speed>(() =>
    savedPreference("speed", "standard") === "fast" ? "fast" : "standard"
  );
  const [selectedContextProfile, setSelectedContextProfile] = useState<ContextProfile>(() =>
    savedPreference("context_profile", "default") === "long_1m" ? "long_1m" : "default"
  );
  const runSelection = useMemo(
    () => resolveRunSelection(status, modelOptions, {
      model: selectedModel,
      effort: selectedEffort,
      speed: selectedSpeed,
      contextProfile: selectedContextProfile
    }),
    [status, modelOptions, selectedModel, selectedEffort, selectedSpeed, selectedContextProfile]
  );
  const selectedModelOption = runSelection.option;

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const chatMessageSequence = useRef(0);
  const busySessionIDsRef = useRef(new Set<string>());

  const selectedProject = useMemo(
    () => projects?.find((p) => p.id === selectedProjectID) ?? null,
    [projects, selectedProjectID]
  );
  const selectedSession = useMemo(
    () => sessions?.find((s) => s.id === selectedSessionID) ?? null,
    [sessions, selectedSessionID]
  );
  const activeRun = useMemo(
    () => runs?.find((r) => r.id === selectedRunID) ?? runs?.[0] ?? null,
    [runs, selectedRunID]
  );
  const chatMode = sessionChatModes[selectedSessionID] ?? "chat";
  const currentPlanCycle = planCycles[selectedSessionID] ?? null;
  const researchQuery = sessionDrafts[selectedSessionID] ?? "";
  const sessionBusy = busySessions[selectedSessionID] === true;
  const coreReady = status?.ready === true;

  const reasoningOptions = selectedModelOption?.supported_reasoning_efforts ?? [];
  const reasoningIndex = Math.max(0, reasoningOptions.indexOf(selectedEffort));
  const reasoningProgress =
    reasoningOptions.length > 1 ? (reasoningIndex / (reasoningOptions.length - 1)) * 100 : 0;
  const longContextEligible = selectedModelOption?.id === "gpt-5.6-sol";

  const selectedArtifact = useMemo(
    () => artifacts?.find((a) => a.id === selectedArtifactID) ?? null,
    [artifacts, selectedArtifactID]
  );
  const selectedArtifactPresentation = useMemo(
    () => (selectedArtifact ? artifactPresentation(selectedArtifact.kind) : null),
    [selectedArtifact]
  );

  const contextUsage = contextUsages[selectedSessionID] ?? null;

  const transcriptItems = useMemo(() => {
    const chats = sessionChats[selectedSessionID] ?? [];
    return chats.map((m) => ({ kind: "chat" as const, message: m }));
  }, [sessionChats, selectedSessionID]);

  // Load Status & Initial Data
  const refreshWorkspace = useCallback(async () => {
    try {
      const statusRes = await get<JsonRecord>("/api/v1/status");
      setStatus(statusRes);
      setConnection("connected");

      const updateRes = await get<JsonRecord>("/api/v1/runtime-update").catch(() => null);
      setRuntimeUpdate(updateRes);

      const codexRes = await get<CodexAccountStatus>("/api/v1/auth/codex/status").catch(() => null);
      setCodexAccount(codexRes);

      const projRes = await get<unknown>("/api/v1/projects").catch(() => null);
      const projList = (listFrom(projRes, "projects") as Project[]) ?? [];
      setProjects(projList);

      if (!selectedProjectID && projList.length > 0) {
        setSelectedProjectID(projList[0].id);
      }
    } catch {
      setConnection("offline");
    }
  }, [selectedProjectID]);

  useEffect(() => {
    void refreshWorkspace();
    const interval = setInterval(refreshWorkspace, 10000);
    return () => clearInterval(interval);
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!runSelection.option) return;
    if (selectedModel !== runSelection.model) {
      setSelectedModel(runSelection.model);
      savePreference("model", runSelection.model);
    }
    if (selectedEffort !== runSelection.effort) {
      setSelectedEffort(runSelection.effort);
      savePreference("effort", runSelection.effort);
    }
    if (selectedSpeed !== runSelection.speed) {
      setSelectedSpeed(runSelection.speed);
      savePreference("speed", runSelection.speed);
    }
    if (selectedContextProfile !== runSelection.contextProfile) {
      setSelectedContextProfile(runSelection.contextProfile);
      savePreference("context_profile", runSelection.contextProfile);
    }
  }, [runSelection, selectedModel, selectedEffort, selectedSpeed, selectedContextProfile]);

  // Load Sessions for Selected Project
  const loadSessions = useCallback(async (projectID: string, targetSessionID?: string) => {
    if (!projectID) return;
    try {
      const res = await get<unknown>(`/api/v1/projects/${encodeURIComponent(projectID)}/sessions`);
      const list = (listFrom(res, "sessions") as ConversationSession[]) ?? [];
      setSessions(list);
      if (targetSessionID && list.some((s) => s.id === targetSessionID)) {
        setSelectedSessionID(targetSessionID);
      } else if (!selectedSessionID || !list.some((s) => s.id === selectedSessionID)) {
        if (list.length > 0) setSelectedSessionID(list[0].id);
      }
    } catch {
      // Ignore
    }
  }, [selectedSessionID]);

  useEffect(() => {
    if (selectedProjectID) void loadSessions(selectedProjectID);
  }, [selectedProjectID, loadSessions]);

  useEffect(() => {
    if (!selectedSessionID) return;
    let cancelled = false;
    void get<unknown>(`/api/v1/sessions/${encodeURIComponent(selectedSessionID)}/chat`)
      .then((payload) => {
        if (cancelled) return;
        const restored = chatHistoryMessages(payload, selectedSessionID);
        setSessionChats((previous) => ({ ...previous, [selectedSessionID]: restored }));
      })
      .catch(() => {
        // A transient App Server history failure must not erase visible local messages.
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionID]);

  useEffect(() => {
    if (selectedSessionID) void loadPlanCycle(selectedSessionID);
  }, [selectedSessionID]);

  // Load Runs, Artifacts, Approvals for Selected Session
  const loadRuns = useCallback(async (sessionID: string) => {
    if (!sessionID) return;
    try {
      const res = await get<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionID)}/runs`);
      const list = (listFrom(res, "runs") as Run[]) ?? [];
      setRuns(list);
      if (list.length > 0 && !selectedRunID) {
        setSelectedRunID(list[0].id);
      }
    } catch {
      // Ignore
    }
  }, [selectedRunID]);

  const loadArtifacts = useCallback(async (runID: string) => {
    if (!runID) return;
    try {
      const res = await get<unknown>(`/api/v1/runs/${encodeURIComponent(runID)}/artifacts`);
      const list = (listFrom(res, "artifacts") as Artifact[]) ?? [];
      setArtifacts(list);
    } catch {
      // Ignore
    }
  }, []);

  const loadApprovals = useCallback(async () => {
    try {
      const res = await get<unknown>("/api/v1/approvals");
      const list = (listFrom(res, "approvals") as Approval[]) ?? [];
      setApprovals(list);
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    if (selectedSessionID) void loadRuns(selectedSessionID);
  }, [selectedSessionID, loadRuns]);

  useEffect(() => {
    if (selectedRunID) void loadArtifacts(selectedRunID);
  }, [selectedRunID, loadArtifacts]);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  useEffect(() => {
    if (activeRun?.status !== "waiting_approval") return;
    void loadApprovals();
    const interval = window.setInterval(() => void loadApprovals(), 1000);
    return () => window.clearInterval(interval);
  }, [activeRun?.id, activeRun?.status, loadApprovals]);

  // SSE Run Events Subscription
  useEffect(() => {
    const cleanup = subscribeToRunEvents(
      "",
      (event: RunEvent) => {
        setEvents((prev) => [event, ...prev.slice(0, 19)]);
        if (shouldRefreshApprovals(event.kind)) {
          void loadApprovals();
        }
        if (selectedSessionID) {
          void loadRuns(selectedSessionID);
        }
        if (selectedRunID) {
          void loadArtifacts(selectedRunID);
        }
      },
      (issue: string) => setEventIssue(issue)
    );
    return cleanup;
  }, [selectedSessionID, selectedRunID, loadApprovals, loadRuns, loadArtifacts]);

  // Keyboard Shortcuts (Ctrl+N, Esc)
  useEffect(() => {
    function handleGlobalKeyDown(e: globalThis.KeyboardEvent) {
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        void createConversationSession();
      } else if (e.key === "Escape") {
        setModelSettingsOpen(false);
        setContextDetailsOpen(false);
        setSlashMenuOpen(false);
        setDrawerArtifact(null);
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  });

  // Project & Session Management Actions
  async function createProject(event: Event) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name || busy !== null) return;
    setBusy("project");
    setActionError(null);
    try {
      const res = await post<unknown>("/api/v1/projects", { name });
      const proj = objectFrom(res, "project") as Project | null;
      setNewProjectName("");
      setNotice("프로젝트를 만들었습니다.");
      await refreshWorkspace();
      if (proj?.id) setSelectedProjectID(proj.id);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function renameProject(projectID: string) {
    const name = projectNameDraft.trim();
    if (!name || busy !== null) return;
    setBusy("project-rename");
    setActionError(null);
    try {
      const updated = objectFrom(
        await patch<unknown>(`/api/v1/projects/${encodeURIComponent(projectID)}`, { name })
      ) as Project | null;
      setProjects(
        (existing) =>
          existing?.map((p) => (p.id === projectID ? { ...p, ...(updated ?? {}), name } : p)) ?? null
      );
      setRenamingProjectID("");
      setProjectNameDraft("");
      setNotice("프로젝트 이름을 변경했습니다.");
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function createConversationSession() {
    if (!selectedProjectID || busy !== null) return;
    setBusy("session-create");
    setActionError(null);
    try {
      const res = await post<unknown>(
        `/api/v1/projects/${encodeURIComponent(selectedProjectID)}/sessions`,
        { title: "새 대화" }
      );
      const session = objectFrom(res) as ConversationSession | null;
      await loadSessions(selectedProjectID, session?.id ?? "");
      setNotice("새 대화를 만들었습니다.");
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function renameConversationSession(sessionID: string) {
    const title = sessionTitleDraft.trim();
    if (!title || busy !== null || busySessions[sessionID]) return;
    setBusy("session-rename");
    setActionError(null);
    try {
      await patch<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionID)}`, { title });
      setRenamingSessionID("");
      await loadSessions(selectedProjectID, sessionID);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteConversationSession(session: ConversationSession) {
    if (
      busy !== null ||
      busySessions[session.id] ||
      !window.confirm(`“${session.title}” 대화를 목록에서 삭제할까요? Codex 대화 원문은 지우지 않습니다.`)
    )
      return;
    setBusy("session-delete");
    setActionError(null);
    try {
      await del<unknown>(`/api/v1/sessions/${encodeURIComponent(session.id)}`);
      setSessionDrafts((prev) => {
        const next = { ...prev };
        delete next[session.id];
        return next;
      });
      setSessionChats((prev) => {
        const next = { ...prev };
        delete next[session.id];
        return next;
      });
      await loadSessions(selectedProjectID);
      setNotice("대화를 목록에서 삭제했습니다.");
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  // Chat & Messaging Logic
  function appendChatMessage(
    sessionID: string,
    role: ChatMessage["role"],
    text: string,
    mode: ChatMode,
    plan?: Pick<ChatMessage, "planReady" | "planQuestions" | "planCycleID">
  ) {
    const msg: ChatMessage = {
      id: `${Date.now()}-${++chatMessageSequence.current}`,
      sessionID,
      role,
      text,
      mode,
      createdAt: new Date().toISOString(),
      planReady: plan?.planReady,
      planQuestions: plan?.planQuestions,
      planCycleID: plan?.planCycleID
    };
    setSessionChats((prev) => ({
      ...prev,
      [sessionID]: [...(prev[sessionID] ?? []), msg]
    }));
    return msg;
  }

  async function loadPlanCycle(sessionID: string) {
    try {
      const res = await get<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionID)}/plan-cycle`);
      const cycle = objectFrom(res, "plan_cycle") as ConversationPlanCycle | null;
      setPlanCycles((prev) => ({ ...prev, [sessionID]: cycle }));
      return cycle;
    } catch {
      return null;
    }
  }

  async function beginPlanCycle(sessionID: string) {
    const objective = planningObjective(sessionChats[sessionID] ?? []);
    try {
      const res = await post<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionID)}/plan-cycle`, {
        objective
      });
      const cycle = objectFrom(res, "plan_cycle") as ConversationPlanCycle | null;
      if (!cycle?.id || cycle.status !== "active") {
        throw new Error("계획 주기를 시작하지 못했습니다.");
      }
      setPlanCycles((prev) => ({ ...prev, [sessionID]: cycle }));
      return cycle;
    } catch (err) {
      setActionError(formatApiError(err));
      return null;
    }
  }

  async function sendChat(
    message: string,
    mode: ChatMode,
    options: { displayUser?: boolean; displayText?: string; planCycleID?: string } = {}
  ) {
    if (sessionBusy || busySessionIDsRef.current.has(selectedSessionID) || busy === "run" || busy === "steer")
      return false;
    if (!coreReady || !selectedSessionID || !runSelection.option || !runSelection.effort) {
      setActionError("대화와 관리 런타임, 모델 설정을 먼저 확인해 주세요.");
      return false;
    }
    const sessionID = selectedSessionID;
    busySessionIDsRef.current.add(sessionID);
    if (options.displayUser !== false)
      appendChatMessage(sessionID, "user", options.displayText ?? message, mode);
    setSessionDrafts((prev) => ({ ...prev, [sessionID]: "" }));
    setBusySessions((prev) => ({ ...prev, [sessionID]: true }));
    setModelSettingsOpen(false);
    setActionError(null);
    setNotice(null);

    try {
      const planCycleID = mode === "plan" ? options.planCycleID ?? currentPlanCycle?.id ?? "" : "";
      const payload = await post<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionID)}/chat`, {
        message,
        mode,
        model: runSelection.model,
        reasoning_effort: runSelection.effort,
        speed: runSelection.speed,
        context_profile: runSelection.contextProfile,
        plan_cycle_id: planCycleID
      });
      const reply = objectFrom(payload) as ChatReply | null;
      const assistantText = reply ? stringValue(reply.text) : undefined;
      if (!assistantText) throw new Error("Codex가 표시할 답변을 반환하지 않았습니다.");

      appendChatMessage(sessionID, "assistant", assistantText, mode, {
        planReady: reply?.plan_ready === true,
        planQuestions: Array.isArray(reply?.plan_questions) ? reply.plan_questions : undefined,
        planCycleID: reply?.plan_cycle_id ?? planCycleID
      });

      if (mode === "plan") await loadPlanCycle(sessionID);
      return true;
    } catch (err) {
      setActionError(formatApiError(err));
      return false;
    } finally {
      busySessionIDsRef.current.delete(sessionID);
      setBusySessions((prev) => ({ ...prev, [sessionID]: false }));
    }
  }

  async function handleSlashCommand(command: string) {
    setSlashMenuOpen(false);
    if (command === "/plan") {
      const sessionID = selectedSessionID;
      if (!sessionID) return;
      setSessionChatModes((prev) => ({ ...prev, [sessionID]: "plan" }));
      const latest = await loadPlanCycle(sessionID);
      const cycle = latest?.status === "active" ? latest : await beginPlanCycle(sessionID);
      if (!cycle) return;
      appendChatMessage(
        sessionID,
        "system",
        "계획 모드를 시작합니다. 연구 목적과 범위를 함께 정리합니다.",
        "plan"
      );
      if (!latest || latest.status !== "active") {
        await sendChat("연구를 시작하기 위한 계획 인터뷰를 시작해줘", "plan", {
          displayUser: false,
          planCycleID: cycle.id
        });
      }
    } else if (command === "/chat") {
      setSessionChatModes((prev) => ({ ...prev, [selectedSessionID]: "chat" }));
      appendChatMessage(selectedSessionID, "system", "일반 대화 모드로 전환했습니다.", "chat");
    } else if (command === "/research") {
      if (currentPlanCycle?.status === "ready" && currentPlanCycle.final_plan) {
        void startPlannedResearch();
      } else {
        setActionError("완성된 계획이 없습니다. /plan으로 먼저 계획을 세우거나 직접 질문을 입력하세요.");
      }
    } else if (command === "/help") {
      appendChatMessage(
        selectedSessionID,
        "system",
        "**사용 가능한 명령어**\n- `/plan`: 대화형 계획 모드 시작\n- `/research`: 합의된 계획으로 연구 시작\n- `/chat`: 일반 대화 모드로 전환",
        chatMode
      );
    }
  }

  function submitComposer() {
    const raw = researchQuery.trim();
    if (!raw) return;
    if (raw.startsWith("/")) {
      void handleSlashCommand(raw);
      return;
    }
    void sendChat(raw, chatMode);
  }

  function handleComposerKeyDown(event: globalThis.KeyboardEvent) {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      void steerResearch();
      return;
    }
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    submitComposer();
  }

  async function steerResearch() {
    const message = researchQuery.trim();
    if (!message || !activeRun) return;
    setBusy("steer");
    setActionError(null);
    try {
      await post(`/api/v1/runs/${encodeURIComponent(activeRun.id)}/steer`, { message });
      setSessionDrafts((prev) => ({ ...prev, [selectedSessionID]: "" }));
      setNotice("진행 중인 연구에 스티어링 메시지를 보냈습니다.");
      await loadRuns(selectedSessionID);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function startPlannedResearch(msg?: ChatMessage) {
    if (!selectedSessionID || !selectedProjectID) return;
    const planCycleID = currentPlanCycle?.id ?? msg?.planCycleID ?? "";
    if (!planCycleID) {
      setActionError("완료된 계획을 찾지 못했습니다. 계획 카드를 다시 불러와 주세요.");
      return;
    }
    setBusy("run");
    setActionError(null);
    try {
      const res = await post<unknown>(
        `/api/v1/sessions/${encodeURIComponent(selectedSessionID)}/planned-runs`,
        {
          plan_cycle_id: planCycleID,
          model: runSelection.model,
          reasoning_effort: runSelection.effort,
          speed: runSelection.speed,
          context_profile: runSelection.contextProfile
        }
      );
      const run = objectFrom(res, "run") as Run | null;
      if (run?.id) {
        setSelectedRunID(run.id);
        setNotice("연구 파이프라인(PLAN → COLLECT → SYNTHESIZE → REVIEW)을 시작했습니다.");
      }
      await loadRuns(selectedSessionID);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  // Plan Questionnaire Interactivity
  function selectPlanAnswer(messageID: string, questionID: string, optionID: string) {
    setPlanSelections((prev) => ({
      ...prev,
      [messageID]: {
        ...(prev[messageID] ?? {}),
        [questionID]: { optionID, custom: prev[messageID]?.[questionID]?.custom ?? "" }
      }
    }));
  }

  function setPlanCustomAnswer(messageID: string, questionID: string, custom: string) {
    setPlanSelections((prev) => ({
      ...prev,
      [messageID]: {
        ...(prev[messageID] ?? {}),
        [questionID]: { optionID: "__other__", custom }
      }
    }));
  }

  async function submitPlanAnswers(message: ChatMessage) {
    const questions = message.planQuestions ?? [];
    const selections = planSelections[message.id] ?? {};
    const answers = questions.map((q) => {
      const sel = selections[q.id];
      if (sel?.optionID === "__other__") {
        return `[${q.header}] ${sel.custom}`;
      }
      const opt = q.options.find((o) => o.id === sel?.optionID);
      return `[${q.header}] ${opt?.label ?? ""}`;
    });
    setSubmittedPlanQuestions((prev) => ({ ...prev, [message.id]: true }));
    const replyText = `질문에 대한 선택 답변입니다:\n${answers.join("\n")}`;
    await sendChat(replyText, "plan", {
      planCycleID: message.planCycleID,
      displayText: `계획 선택을 완료했습니다:\n${answers.join("\n")}`
    });
  }

  // Run Control & Approvals
  async function runAction(action: "cancel" | "resume" | "discard") {
    if (!activeRun) return;
    setBusy(action);
    setActionError(null);
    try {
      if (action === "cancel") await post(`/api/v1/runs/${encodeURIComponent(activeRun.id)}/cancel`, {});
      if (action === "resume") await post(`/api/v1/runs/${encodeURIComponent(activeRun.id)}/resume`, {});
      if (action === "discard") {
        await post(`/api/v1/runs/${encodeURIComponent(activeRun.id)}/discard`, {});
      }
      setNotice(`연구를 ${action === "cancel" ? "취소" : action === "resume" ? "재개" : "폐기"}했습니다.`);
      await loadRuns(selectedSessionID);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function decideApproval(approval: Approval, decision: "approved" | "denied") {
    setBusy(`approval-${approval.id}`);
    setActionError(null);
    try {
      await post(`/api/v1/approvals/${encodeURIComponent(approval.id)}/decision`, { decision });
      setNotice(`도구 실행을 ${decision === "approved" ? "승인" : "거절"}했습니다.`);
      await loadApprovals();
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function selectArtifact(artifact: Artifact) {
    setSelectedArtifactID(artifact.id);
    setBusy("artifact");
    setActionError(null);
    try {
      const res = await fetchArtifact(artifactContentPath(artifact.id));
		setArtifactContent(res?.json ?? res?.text ?? res?.blob ?? res);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  async function openArtifactInDrawer(artifact: Artifact) {
    setSelectedArtifactID(artifact.id);
    setDrawerArtifact(artifact);
    setBusy("artifact");
    setActionError(null);
    try {
      const res = await fetchArtifact(artifactContentPath(artifact.id));
		setArtifactContent(res?.json ?? res?.text ?? res?.blob ?? res);
    } catch (err) {
      setActionError(formatApiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="app-shell">
      <ProjectSessionSidebar
        view={view}
        onSetView={setView}
        projects={projects}
        selectedProjectID={selectedProjectID}
        onSelectProject={(id) => {
          setSelectedProjectID(id);
          setCollapsedProjectIDs((prev) => prev.filter((item) => item !== id));
        }}
        sessions={sessions}
        selectedSessionID={selectedSessionID}
        onSelectSession={(id) => {
          setSelectedSessionID(id);
          setView("workspace");
        }}
        connection={connection}
        busy={busy}
        busySessions={busySessions}
        collapsedProjectIDs={collapsedProjectIDs}
        onToggleProjectCollapse={(id) => {
          setCollapsedProjectIDs((prev) =>
            prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
          );
        }}
        newProjectName={newProjectName}
        onNewProjectNameChange={setNewProjectName}
        onCreateProject={createProject}
        onCreateSession={createConversationSession}
        renamingProjectID={renamingProjectID}
        projectNameDraft={projectNameDraft}
        onProjectNameDraftChange={setProjectNameDraft}
        onBeginRenameProject={(p) => {
          setRenamingProjectID(p.id);
          setProjectNameDraft(p.name);
        }}
        onRenameProject={renameProject}
        onCancelRenameProject={() => {
          setRenamingProjectID("");
          setProjectNameDraft("");
        }}
        renamingSessionID={renamingSessionID}
        sessionTitleDraft={sessionTitleDraft}
        onSessionTitleDraftChange={setSessionTitleDraft}
        onBeginRenameSession={(s) => {
          setRenamingSessionID(s.id);
          setSessionTitleDraft(s.title);
        }}
        onRenameSession={renameConversationSession}
        onCancelRenameSession={() => setRenamingSessionID("")}
        onDeleteSession={deleteConversationSession}
      />

      <main class={view === "workspace" ? "main-content workspace-view" : "main-content"}>
        <WorkspaceHeader
          view={view}
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          busy={busy}
          onRefresh={refreshWorkspace}
        />

        {connection === "offline" && (
          <div class="alert danger" role="alert">
            <strong>연결할 수 없습니다.</strong> AetherOps 핵심 서비스가 실행 중인지 확인한 뒤 다시 시도하세요.
          </div>
        )}
        {actionError && <div class="alert danger" role="alert">{actionError}</div>}
        {notice && <div class="alert success" role="status">{notice}</div>}
        {eventIssue && <div class="alert subtle" role="status">{eventIssue}</div>}

        {view === "workspace" && (
          <div class={coreReady ? "chat-workspace" : "chat-workspace runtime-limited"}>
            <div class="chat-panel">
              <ChatWorkspace
                transcriptRef={transcriptRef}
                transcriptItems={transcriptItems}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                chatMode={chatMode}
                activeRun={activeRun}
                connection={connection}
                planSelections={planSelections}
                submittedPlanQuestions={submittedPlanQuestions}
                currentPlanCycle={currentPlanCycle}
                sessionBusy={sessionBusy}
                busy={busy}
                onSelectSlashCommand={(cmd) => {
                  if (cmd === "/plan" || cmd === "/research" || cmd === "/chat" || cmd === "/help") {
                    void handleSlashCommand(cmd);
                  }
                }}
                onSelectPlanAnswer={selectPlanAnswer}
                onSetPlanCustomAnswer={setPlanCustomAnswer}
                onSubmitPlanAnswers={submitPlanAnswers}
                onStartPlannedResearch={startPlannedResearch}
                formatDate={formatDate}
              />

              <ChatComposer
                query={researchQuery}
                onQueryChange={(val) => {
                  setSessionDrafts((prev) => ({ ...prev, [selectedSessionID]: val }));
                  if (val.startsWith("/")) {
                    setSlashMenuOpen(true);
                    setSlashQuery(val);
                  } else {
                    setSlashMenuOpen(false);
                  }
                }}
                onSubmit={submitComposer}
                onKeyDown={handleComposerKeyDown}
                chatMode={chatMode}
                onClosePlanMode={() => handleSlashCommand("/chat")}
                slashMenuOpen={slashMenuOpen}
                slashQuery={slashQuery}
                onSelectSlashCommand={(cmd) => {
                  setSessionDrafts((prev) => ({ ...prev, [selectedSessionID]: "" }));
                  void handleSlashCommand(cmd);
                }}
                coreReady={coreReady}
                connection={connection}
                selectedSessionID={selectedSessionID}
                sessionBusy={sessionBusy}
                busy={busy}
                activeRun={activeRun}
                artifactsCount={artifacts?.length ?? null}
                onOpenActiveRun={() => {
                  if (activeRun) setSelectedRunID(activeRun.id);
                }}
                composerRef={composerRef}
                contextUsage={contextUsage}
                selectedContextProfile={selectedContextProfile}
                contextDetailsOpen={contextDetailsOpen}
                onToggleContextDetails={() => {
                  setModelSettingsOpen(false);
                  setContextDetailsOpen((open) => !open);
                }}
                modelSettingsOpen={modelSettingsOpen}
                modelOptions={modelOptions}
                selectedModel={selectedModel}
                selectedEffort={selectedEffort}
                selectedSpeed={selectedSpeed}
                reasoningOptions={reasoningOptions}
                reasoningIndex={reasoningIndex}
                reasoningProgress={reasoningProgress}
                longContextEligible={longContextEligible}
                selectedModelOption={selectedModelOption ?? undefined}
                onSelectModel={(id) => {
                  setSelectedModel(id);
                  savePreference("model", id);
                }}
                onSelectEffort={(effort) => {
                  setSelectedEffort(effort);
                  savePreference("effort", effort);
                }}
                onSelectSpeed={(speed) => {
                  setSelectedSpeed(speed);
                  savePreference("speed", speed);
                }}
                onSelectContextProfile={(profile) => {
                  setSelectedContextProfile(profile);
                  savePreference("context_profile", profile);
                }}
                onToggleModelSettings={() => {
                  setContextDetailsOpen(false);
                  setModelSettingsOpen((open) => !open);
                }}
                onCloseModelSettings={() => setModelSettingsOpen(false)}
                onSelectPromptChip={(promptText) => {
                  setSessionDrafts((prev) => ({ ...prev, [selectedSessionID]: promptText }));
                  composerRef.current?.focus();
                }}
              />
            </div>

            <ResearchSummaryRail
              activeRun={activeRun}
              artifacts={artifacts}
              selectedArtifactID={selectedArtifactID}
              onOpenArtifact={openArtifactInDrawer}
              events={events}
              approvals={approvals}
              onDecideApproval={decideApproval}
              blockingRun={activeRun ? blockingRunFrom(activeRun) : null}
              onOpenBlockingRun={() => {
                const b = activeRun ? blockingRunFrom(activeRun) : null;
                if (b) setSelectedRunID(b.id);
              }}
              warnings={warnings}
              onSetView={setView}
              busy={busy}
              onRunAction={runAction}
              formatDate={formatDate}
              stageState={stageState}
            />
          </div>
        )}

        {view === "knowledge" && (
          <Suspense
            fallback={
              <section class="panel">
                <EmptyState
                  title="지식 화면을 불러오는 중"
                  detail="그래프 편집기를 준비하고 있습니다."
                />
              </section>
            }
          >
            <KnowledgeView
              projectID={selectedProjectID}
              projectName={selectedProject?.name}
              connected={connection === "connected"}
            />
          </Suspense>
        )}

        {view === "tools" && (
          <Suspense
            fallback={
              <section class="panel">
                <p class="muted">Tool Studio를 불러오는 중입니다.</p>
              </section>
            }
          >
            <ToolStudioView projectID={selectedProjectID} connected={connection === "connected"} />
          </Suspense>
        )}

        {view === "artifacts" && (
          <ArtifactsView
            runs={runs}
            activeRun={activeRun}
            selectedRunID={selectedRunID}
            onSelectRunID={(id) => {
              setSelectedRunID(id);
              void loadArtifacts(id);
            }}
            artifacts={artifacts}
            selectedArtifactID={selectedArtifactID}
            onSelectArtifact={selectArtifact}
            artifactContent={artifactContent}
            busy={busy}
            formatDate={formatDate}
          />
        )}

        {view === "schedules" && (
          <SchedulesView
            projects={projects}
            sessions={sessions}
            selectedProjectID={selectedProjectID}
            onSelectProjectID={setSelectedProjectID}
            selectedSessionID={selectedSessionID}
            onSelectSessionID={setSelectedSessionID}
            schedules={schedules}
            coreReady={coreReady}
            busy={busy}
            onCreateSchedule={async (data) => {
              setBusy("schedule-create");
              try {
                await post("/api/v1/schedules", data);
                setNotice("연구 일정을 등록했습니다.");
                await refreshWorkspace();
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
            onToggleScheduleEnabled={async (scheduleID, enabled) => {
              setBusy(`schedule-toggle-${scheduleID}`);
              try {
                await post(`/api/v1/schedules/${encodeURIComponent(scheduleID)}/enabled`, { enabled });
                setNotice(enabled ? "연구 일정을 다시 활성화했습니다." : "연구 일정을 일시 중지했습니다.");
                await refreshWorkspace();
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
            onDeleteSchedule={async (scheduleID) => {
              setBusy(`schedule-delete-${scheduleID}`);
              try {
                await del(`/api/v1/schedules/${encodeURIComponent(scheduleID)}`);
                setNotice("연구 일정을 삭제했습니다.");
                await refreshWorkspace();
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
            formatDate={formatDate}
          />
        )}

        {view === "controls" && (
          <ControlsView
            browserState={browserState}
            browserMode={browserMode}
            connection={connection}
            busy={busy}
            onSetBrowserMode={async (mode) => {
              setBusy("browser-mode");
              try {
                await post("/api/v1/browser/mode", { mode });
                setNotice(`브라우저 제어를 ${mode === "manual" ? "수동" : "자동"} 모드로 전환했습니다.`);
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
            onEmergencyStop={async () => {
              setBusy("emergency-stop");
              try {
                await post("/api/v1/browser/emergency-stop", {});
                setNotice("전역 긴급 중지 신호를 전송했습니다.");
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
          />
        )}

        {view === "settings" && (
          <SettingsView
            selectedProject={selectedProject}
            codexAccount={codexAccount}
            deviceCode={deviceCode}
            onRequestDeviceCode={async () => {
              setBusy("device-code");
              try {
                const res = await post<JsonRecord>("/api/v1/auth/codex/device-code", {});
                setDeviceCode(res);
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
            apiKey={apiKey}
            onApiKeyChange={setApiKey}
            onSaveApiKey={async (e) => {
              e.preventDefault();
              if (!apiKey.trim()) return;
              setBusy("api-key");
              try {
                await post("/api/v1/settings/openai-api-key", { api_key: apiKey });
                setApiKey("");
                setNotice("API 키를 안전하게 저장했습니다.");
                await refreshWorkspace();
              } catch (err) {
                setActionError(formatApiError(err));
              } finally {
                setBusy(null);
              }
            }}
            runtimeUpdate={runtimeUpdate}
            connection={connection}
            coreReady={coreReady}
            busy={busy}
            onProjectDeleted={async (casCleanupPending) => {
              setNotice(
                casCleanupPending > 0
                  ? `프로젝트를 삭제했습니다. CAS 객체 ${casCleanupPending}개는 다음 AetherOps 시작 때 정리합니다.`
                  : "프로젝트를 삭제했습니다."
              );
              await refreshWorkspace();
            }}
          />
        )}
      </main>

      {/* In-context Slide-over Drawer for Artifacts */}
      {drawerArtifact && (
        <ArtifactDrawer
          artifact={drawerArtifact}
          content={artifactContent}
          presentation={artifactPresentation(drawerArtifact.kind)}
          busy={busy === "artifact"}
          onClose={() => setDrawerArtifact(null)}
        />
      )}
    </div>
  );
}

render(<App />, document.getElementById("app")!);
