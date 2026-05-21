import {
  Bot,
  Boxes,
  CheckCircle2,
  Check,
  ChevronDown,
  Database,
  FileText,
  FlaskConical,
  Folder,
  FolderKanban,
  Gauge,
  GitBranch,
  Globe2,
  HardDrive,
  History,
  KeyRound,
  Loader2,
  MessageSquare,
  Paperclip,
  Plus,
  Save,
  Search,
  Send,
  Settings,
  Target,
  Trash2,
  Workflow,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import {
  ResearchLoopStep,
  type AppSettings,
  type ResearchProjectInput,
  type LoopIteration,
  type OpenCodeApiLlmSettings,
  type ResearchProject,
  type ResearchSnapshot
} from "../core/types.js";
import { getAetherOpsApi, getMissingAetherOpsApiMessage, waitForAetherOpsApi } from "./aetherClient.js";

const api = getAetherOpsApi();
const workspaceStateKey = "aetherops.workspaceState";

type SidebarTab = "aetherops" | "new-chat" | "search" | "plugins" | "automation" | "settings";
type ProjectView = "dashboard" | "chat";
type IconComponent = typeof Target;
type StepFlowClass = "main" | "data" | "agent" | "storage" | "knowledge" | "loop" | "output";
type HomeModelSelection =
  | { source: "codex-oauth"; model: string }
  | { source: "api"; provider: OpenCodeApiLlmSettings["provider"]; model: string };
interface PendingChatMessage {
  sessionId: string;
  content: string;
  createdAt: string;
  startedAt: number;
}

const defaultInput: ResearchProjectInput = {
  goal: "근거 기반 반복 연구 루프가 질문, 가설, 자료, 산출물을 스스로 개선하는지 검증한다.",
  topic: "AetherOps 자율 연구 루프",
  scope: "도구 실행, 로컬 Vector Index, Ontology Graph, 산출물 저장, evidence gap 기록을 포함한 MVP 검증",
  budget: "로컬 MVP 예산",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 2,
    allowExternalSearch: true,
    allowCodeExecution: false
  }
};

const providerLabels: Record<OpenCodeApiLlmSettings["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  custom: "사용자 지정"
};

const modelOptions: Record<OpenCodeApiLlmSettings["provider"], string[]> = {
  openai: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
  google: ["gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  custom: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "claude-sonnet-4-6", "gemini-3-pro-preview", "local-model"]
};

const codexOAuthModels = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"];

const defaultApiSettings: OpenCodeApiLlmSettings = {
  source: "api",
  provider: "openai",
  model: modelOptions.openai[0],
  baseUrl: "",
  apiKeyConfigured: false
};

const openCodeCommandOptions = ["opencode", "opencode.cmd"];
const openCodeProviderOptions = ["openai", "anthropic", "google", "custom"];
const openCodeOAuthProviderOptions = ["대화형 선택", "openai", "anthropic", "github-copilot", "google", "opencode"];
const openCodeTimeoutOptions = [60_000, 120_000, 180_000, 300_000, 600_000];
const embeddingModelOptions: Record<AppSettings["embedding"]["provider"], string[]> = {
  local: ["local-hash"],
  openai: ["text-embedding-3-small", "text-embedding-3-large"],
  google: ["gemini-embedding-001"],
  custom: ["text-embedding-3-small", "text-embedding-3-large", "gemini-embedding-001", "custom-embedding-model"]
};
const embeddingDimensionOptions = [64, 96, 128, 256, 512, 1024, 1536, 3072];
const maxLoopIterationOptions = [1, 2, 3, 4, 5, 6, 8];

const stepLabels: Record<ResearchLoopStep, { index: string; label: string; flow: StepFlowClass; icon: IconComponent }> = {
  [ResearchLoopStep.CreateResearchDb]: { index: "1", label: "연구 DB 생성", flow: "storage", icon: Database },
  [ResearchLoopStep.InputResearchQuestionHypothesis]: { index: "2", label: "질문/가설 입력", flow: "main", icon: MessageSquare },
  [ResearchLoopStep.BuildResearchSpecification]: { index: "3", label: "연구 명세 수립", flow: "agent", icon: GitBranch },
  [ResearchLoopStep.PlanResearch]: { index: "4", label: "연구 계획 수립", flow: "agent", icon: FolderKanban },
  [ResearchLoopStep.ExecuteTools]: { index: "5", label: "도구 실행 및 연구 수행", flow: "agent", icon: Bot },
  [ResearchLoopStep.NormalizeData]: { index: "6", label: "데이터 수집 및 정규화", flow: "storage", icon: Boxes },
  [ResearchLoopStep.BuildVectorIndex]: { index: "7", label: "Vector Index", flow: "knowledge", icon: Search },
  [ResearchLoopStep.BuildOntologyGraph]: { index: "8", label: "Ontology Graph", flow: "knowledge", icon: Workflow },
  [ResearchLoopStep.ReasonAndValidate]: { index: "9", label: "추론 및 검증", flow: "agent", icon: FlaskConical },
  [ResearchLoopStep.SynthesizeAndEvaluate]: { index: "10", label: "결과 합성 및 가설 평가", flow: "agent", icon: FileText },
  [ResearchLoopStep.DecideContinuation]: { index: "11", label: "계속 연구?", flow: "loop", icon: Gauge },
  [ResearchLoopStep.FinalizeOutputs]: { index: "12", label: "최종 결과 도출", flow: "output", icon: CheckCircle2 }
};

const designSteps = [
  ResearchLoopStep.CreateResearchDb,
  ResearchLoopStep.InputResearchQuestionHypothesis,
  ResearchLoopStep.BuildResearchSpecification,
  ResearchLoopStep.PlanResearch
];

const loopSteps = [
  ResearchLoopStep.ExecuteTools,
  ResearchLoopStep.NormalizeData,
  ResearchLoopStep.BuildVectorIndex,
  ResearchLoopStep.BuildOntologyGraph,
  ResearchLoopStep.ReasonAndValidate,
  ResearchLoopStep.SynthesizeAndEvaluate
];

const decisionSteps = [ResearchLoopStep.DecideContinuation, ResearchLoopStep.FinalizeOutputs];

export function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<SidebarTab>("aetherops");
  const [input, setInput] = useState<ResearchProjectInput>(defaultInput);
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | undefined>();
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [projectView, setProjectView] = useState<ProjectView>("dashboard");
  const [sessionTitle, setSessionTitle] = useState("");
  const [homeProjectId, setHomeProjectId] = useState<string>("");
  const [homePrompt, setHomePrompt] = useState("");
  const [chatPrompt, setChatPrompt] = useState("");
  const [chatError, setChatError] = useState("");
  const [pendingChatMessage, setPendingChatMessage] = useState<PendingChatMessage>();
  const [events, setEvents] = useState<LoopIteration[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>();
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [embeddingKeyInput, setEmbeddingKeyInput] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [openCodeAuthProvider, setOpenCodeAuthProvider] = useState("대화형 선택");
  const [openCodeAuthOutput, setOpenCodeAuthOutput] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const ready = await waitForAetherOpsApi();
      if (disposed) {
        return;
      }
      if (!ready) {
        setRuntimeError(getMissingAetherOpsApiMessage());
        return;
      }

      setRuntimeError("");
      void restoreWorkspace().catch((error: unknown) => {
        if (!disposed) {
          setRuntimeError(formatError(error));
        }
      });
      void api.settings
        .get()
        .then((settings) => {
          if (disposed) {
            return;
          }
          const normalized = normalizeSettings(settings);
          setAppSettings(normalized);
          setSettingsDraft(normalized);
        })
        .catch((error: unknown) => {
          if (!disposed) {
            setRuntimeError(formatError(error));
          }
        });
      try {
        unsubscribe = api.events.onLoopIteration((iteration) => {
          setEvents((current) => [...current, iteration].slice(-16));
        });
      } catch (error) {
        setRuntimeError(formatError(error));
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const metrics = useMemo(
    () => [
      { label: "반복", value: snapshot?.results.length ?? 0 },
      { label: "근거", value: snapshot?.evidence.length ?? 0 },
      { label: "정규화", value: snapshot?.normalizedRecords.length ?? 0 },
      { label: "Vector chunk", value: snapshot?.chunks.length ?? 0 },
      { label: "Graph", value: (snapshot?.ontologyEntities.length ?? 0) + (snapshot?.ontologyRelations.length ?? 0) },
      { label: "검증", value: snapshot?.validationResults.length ?? 0 }
    ],
    [snapshot]
  );

  async function refreshProjects(): Promise<ResearchProject[]> {
    const list = await api.projects.list();
    setProjects(list);
    return list;
  }

  async function restoreWorkspace(): Promise<void> {
    const list = await refreshProjects();
    const saved = readWorkspaceState();
    if (!saved.projectId || !list.some((project) => project.id === saved.projectId)) {
      setHomeProjectId(list[0]?.id ?? "");
      return;
    }
    try {
      const next = await api.snapshots.get(saved.projectId);
      setSnapshot(next);
      setInput({
        goal: next.project.goal,
        topic: next.project.topic,
        scope: next.project.scope,
        budget: next.project.budget,
        autonomyPolicy: next.project.autonomyPolicy
      });
      setEvents(next.iterations.slice(-16));
      const chats = chatSessionsFor(next);
      const restoredSession = saved.sessionId && chats.some((session) => session.id === saved.sessionId) ? saved.sessionId : chats[0]?.id;
      const restoredView = saved.view === "chat" && restoredSession ? "chat" : "dashboard";
      setSelectedSessionId(restoredSession);
      setProjectView(restoredView);
      setHomeProjectId(next.project.id);
      setActiveTab("aetherops");
      rememberWorkspace(next.project.id, restoredView, restoredSession);
    } catch {
      clearWorkspaceState();
    }
  }

  function firstChatSessionId(nextSnapshot: ResearchSnapshot): string | undefined {
    return chatSessionsFor(nextSnapshot)[0]?.id;
  }

  async function createWorkflow(projectInput: ResearchProjectInput): Promise<ResearchSnapshot> {
    setBusy(true);
    try {
      let next = await api.projects.create(projectInput);
      await api.sessions.createForProject(next.project.id);
      next = await api.researchDb.create(next.project.id);
      next = await api.research.seedQuestions(next.project.id);
      setSnapshot(next);
      setEvents(next.iterations.slice(-16));
      const nextSessionId = firstChatSessionId(next);
      setSelectedSessionId(nextSessionId);
      setProjectView("dashboard");
      setHomeProjectId(next.project.id);
      rememberWorkspace(next.project.id, "dashboard", nextSessionId);
      setActiveTab("aetherops");
      await refreshProjects();
      return next;
    } finally {
      setBusy(false);
    }
  }

  async function createExactWorkflow(): Promise<void> {
    await createWorkflow(input);
  }

  async function createProjectFromPrompt(): Promise<void> {
    const prompt = homePrompt.trim();
    const nextInput = prompt
      ? {
          ...defaultInput,
          goal: prompt,
          topic: deriveTopic(prompt),
          scope: "사용자 프롬프트를 기반으로 하위 대화 세션, 연구 DB, RAG 루프를 구성합니다.",
          budget: "초기 자동 생성 프로젝트"
        }
      : input;
    await createWorkflow(nextInput);
  }

  async function startHomeConversation(): Promise<void> {
    const prompt = homePrompt.trim();
    if (!prompt || busy) {
      return;
    }
    if (!homeProjectId) {
      await createProjectFromPrompt();
      return;
    }
    setBusy(true);
    try {
      let next = await api.sessions.create(homeProjectId);
      if (!next.database) {
        next = await api.researchDb.create(next.project.id);
      }
      const nextSession = chatSessionsFor(next).at(-1);
      if (nextSession) {
        setChatError("");
        setPendingChatMessage(createPendingChatMessage(nextSession.id, prompt));
        setSnapshot(next);
        setInput({
          goal: next.project.goal,
          topic: next.project.topic,
          scope: next.project.scope,
          budget: next.project.budget,
          autonomyPolicy: next.project.autonomyPolicy
        });
        setEvents(next.iterations.slice(-16));
        setSelectedSessionId(nextSession.id);
        setProjectView("chat");
        setHomeProjectId(next.project.id);
        setHomePrompt("");
        setActiveTab("aetherops");
        rememberWorkspace(next.project.id, "chat", nextSession.id);
        try {
          next = await api.chat.send(next.project.id, nextSession.id, prompt);
        } catch (error) {
          setChatError(formatError(error));
          next = await api.snapshots.get(next.project.id);
        } finally {
          setPendingChatMessage(undefined);
        }
        setSnapshot(next);
        setInput({
          goal: next.project.goal,
          topic: next.project.topic,
          scope: next.project.scope,
          budget: next.project.budget,
          autonomyPolicy: next.project.autonomyPolicy
        });
        setEvents(next.iterations.slice(-16));
        setSelectedSessionId(nextSession.id);
        setProjectView("chat");
        setHomeProjectId(next.project.id);
        setHomePrompt("");
        setActiveTab("aetherops");
        rememberWorkspace(next.project.id, "chat", nextSession.id);
        await refreshProjects();
        return;
      }
      setSnapshot(next);
      setInput({
        goal: next.project.goal,
        topic: next.project.topic,
        scope: next.project.scope,
        budget: next.project.budget,
        autonomyPolicy: next.project.autonomyPolicy
      });
      setEvents(next.iterations.slice(-16));
      setSelectedSessionId(undefined);
      setProjectView("chat");
      setHomeProjectId(next.project.id);
      setHomePrompt("");
      setActiveTab("aetherops");
      rememberWorkspace(next.project.id, "chat", undefined);
      await refreshProjects();
    } finally {
      setBusy(false);
    }
  }

  async function createBlankProject(): Promise<void> {
    const latestProjects = await refreshProjects();
    const nextNumber = latestProjects.length + 1;
    await createWorkflow({
      ...defaultInput,
      goal: "새 연구 프로젝트의 목표를 입력하세요.",
      topic: `새 연구 프로젝트 ${nextNumber}`,
      scope: "프로젝트 생성 후 연구 목표, 범위, 자료 수집 계획을 구체화합니다.",
      budget: "미정"
    });
  }

  async function selectProject(projectId: string): Promise<void> {
    const next = await api.snapshots.get(projectId);
    setSnapshot(next);
    setInput({
      goal: next.project.goal,
      topic: next.project.topic,
      scope: next.project.scope,
      budget: next.project.budget,
      autonomyPolicy: next.project.autonomyPolicy
    });
    setEvents(next.iterations.slice(-16));
    const nextSessionId = firstChatSessionId(next);
    setSelectedSessionId(nextSessionId);
    setProjectView("dashboard");
    setHomeProjectId(next.project.id);
    rememberWorkspace(next.project.id, "dashboard", nextSessionId);
    setActiveTab("aetherops");
  }

  async function createChatSession(): Promise<void> {
    if (!snapshot || busy) {
      return;
    }
    setBusy(true);
    try {
      const next = await api.sessions.create(snapshot.project.id, sessionTitle || undefined);
      setSnapshot(next);
      setEvents(next.iterations.slice(-16));
      const nextSessionId = chatSessionsFor(next).at(-1)?.id;
      setSelectedSessionId(nextSessionId);
      setProjectView("chat");
      setHomeProjectId(next.project.id);
      rememberWorkspace(next.project.id, "chat", nextSessionId);
      setSessionTitle("");
      await refreshProjects();
      setActiveTab("aetherops");
    } finally {
      setBusy(false);
    }
  }

  function selectDashboard(): void {
    if (snapshot) {
      rememberWorkspace(snapshot.project.id, "dashboard", selectedSessionId);
      setHomeProjectId(snapshot.project.id);
    }
    setProjectView("dashboard");
    setActiveTab("aetherops");
  }

  function selectChatSession(sessionId: string): void {
    if (snapshot) {
      rememberWorkspace(snapshot.project.id, "chat", sessionId);
      setHomeProjectId(snapshot.project.id);
    }
    setChatError("");
    setSelectedSessionId(sessionId);
    setProjectView("chat");
    setActiveTab("aetherops");
  }

  async function deleteChatSession(sessionId: string): Promise<void> {
    if (!snapshot || busy) {
      return;
    }
    const session = snapshot.sessions.find((item) => item.id === sessionId);
    const sessionName = session?.title ?? "채팅 세션";
    if (!window.confirm(`${sessionName}을 삭제할까요? 저장된 연구 산출물과 파일은 유지됩니다.`)) {
      return;
    }
    setBusy(true);
    try {
      const next = await api.sessions.delete(snapshot.project.id, sessionId);
      const remainingSessions = chatSessionsFor(next);
      const deletedSelectedSession = selectedSessionId === sessionId;
      const nextSessionId = deletedSelectedSession ? remainingSessions[0]?.id : selectedSessionId;
      const nextView = deletedSelectedSession ? (nextSessionId ? "chat" : "dashboard") : projectView;
      setSnapshot(next);
      setEvents(next.iterations.slice(-16));
      setSelectedSessionId(nextSessionId);
      setProjectView(nextView);
      setHomeProjectId(next.project.id);
      rememberWorkspace(next.project.id, nextView, nextSessionId);
      await refreshProjects();
    } finally {
      setBusy(false);
    }
  }

  async function submitChatPrompt(): Promise<void> {
    if (!snapshot || !chatPrompt.trim() || busy) {
      return;
    }
    if (!selectedSessionId) {
      setChatError("선택된 채팅 세션이 없습니다. 사이드바에서 세션을 다시 선택해 주세요.");
      return;
    }
    const session = snapshot.sessions.find((item) => item.id === selectedSessionId);
    if (!session) {
      setChatError("선택한 채팅 세션을 찾을 수 없습니다. 세션 목록에서 다시 선택해 주세요.");
      return;
    }
    const content = chatPrompt.trim();
    setBusy(true);
    try {
      setChatError("");
      setPendingChatMessage(createPendingChatMessage(selectedSessionId, content));
      setChatPrompt("");
      const next = await api.chat.send(snapshot.project.id, selectedSessionId, content);
      setSnapshot(next);
      setEvents(next.iterations.slice(-16));
      setProjectView("chat");
      setHomeProjectId(next.project.id);
      rememberWorkspace(next.project.id, "chat", selectedSessionId);
    } catch (error) {
      setChatError(formatError(error));
      try {
        const latest = await api.snapshots.get(snapshot.project.id);
        setSnapshot(latest);
        setEvents(latest.iterations.slice(-16));
      } catch {
        return;
      }
    } finally {
      setPendingChatMessage(undefined);
      setBusy(false);
    }
    return;
  }

  async function startLoop(): Promise<void> {
    if (!snapshot) {
      return;
    }
    setBusy(true);
    try {
      const next = await api.loop.start(snapshot.project.id);
      setSnapshot(next);
      setEvents(next.iterations.slice(-16));
    } finally {
      setBusy(false);
    }
  }

  async function pauseLoop(): Promise<void> {
    if (snapshot) {
      setSnapshot(await api.loop.pause(snapshot.project.id));
    }
  }

  async function resumeLoop(): Promise<void> {
    if (!snapshot) {
      return;
    }
    setBusy(true);
    try {
      setSnapshot(await api.loop.resume(snapshot.project.id));
    } finally {
      setBusy(false);
    }
  }

  async function abortLoop(): Promise<void> {
    if (snapshot) {
      setSnapshot(await api.loop.abort(snapshot.project.id));
    }
  }

  function openNewChatHome(): void {
    setActiveTab("new-chat");
    setHomeProjectId(snapshot?.project.id || homeProjectId || projects[0]?.id || "");
    setHomePrompt("");
  }

  async function saveSettings(): Promise<void> {
    if (!settingsDraft) {
      return;
    }
    const toSave: AppSettings = {
      ...settingsDraft,
      openCodeLlm:
        settingsDraft.openCodeLlm.source === "api"
          ? {
              ...settingsDraft.openCodeLlm,
              apiKey: apiKeyInput.trim() || undefined
            }
          : settingsDraft.openCodeLlm,
      webSearch: {
        ...settingsDraft.webSearch,
        apiKey: webKeyInput.trim() || undefined
      },
      embedding: {
        ...settingsDraft.embedding,
        apiKey: embeddingKeyInput.trim() || undefined
      }
    };
    const saved = normalizeSettings(await api.settings.save(toSave));
    setAppSettings(saved);
    setSettingsDraft(saved);
    setApiKeyInput("");
    setWebKeyInput("");
    setEmbeddingKeyInput("");
    setSettingsMessage("설정이 저장되었습니다.");
  }

  async function loginOpenCodeOAuth(): Promise<void> {
    const provider = openCodeAuthProvider === "대화형 선택" ? undefined : openCodeAuthProvider;
    const result = await api.opencode.authLogin(provider);
    setOpenCodeAuthOutput([result.message, result.output].filter(Boolean).join("\n"));
  }

  async function refreshOpenCodeAuthList(): Promise<void> {
    const result = await api.opencode.authList();
    setOpenCodeAuthOutput([result.message, result.output].filter(Boolean).join("\n"));
  }

  async function selectHomeModel(selection: HomeModelSelection): Promise<void> {
    const current = settingsDraft ?? appSettings;
    if (!current) {
      return;
    }
    const updatedAt = new Date().toISOString();
    const next: AppSettings =
      selection.source === "codex-oauth"
        ? {
            ...current,
            openCodeLlm: {
              source: "codex-oauth",
              model: selection.model
            },
            openCode: {
              ...current.openCode,
              provider: "openai",
              model: selection.model
            },
            updatedAt
          }
        : {
            ...current,
            openCodeLlm: {
              ...(current.openCodeLlm.source === "api" ? current.openCodeLlm : defaultApiSettings),
              source: "api",
              provider: selection.provider,
              model: selection.model
            },
            openCode: {
              ...current.openCode,
              provider: selection.provider,
              model: selection.model
            },
            updatedAt
          };
    const saved = normalizeSettings(await api.settings.save(next));
    setAppSettings(saved);
    setSettingsDraft(saved);
    setSettingsMessage("모델 설정이 저장되었습니다.");
  }

  if (runtimeError) {
    return (
      <main className="codexShell runtimeShell">
        <section className="runtimeErrorView">
          <div className="runtimeErrorCard">
            <h1>AetherOps 실행 연결 오류</h1>
            <p>{runtimeError}</p>
            <code>run-aetherops.bat</code>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="codexShell">
      <CodexSidebar
        activeTab={activeTab}
        projects={projects}
        snapshot={snapshot}
        selectedSessionId={selectedSessionId}
        projectView={projectView}
        sessionTitle={sessionTitle}
        busy={busy}
        onTabChange={setActiveTab}
        onSelectProject={selectProject}
        onSelectDashboard={selectDashboard}
        onSelectSession={selectChatSession}
        onSessionTitleChange={setSessionTitle}
        onCreateChatSession={createChatSession}
        onDeleteSession={deleteChatSession}
        onCreateResearchProject={createBlankProject}
        onNewChat={openNewChatHome}
      />

      {(activeTab === "new-chat" || (activeTab === "aetherops" && !snapshot)) ? (
        <CodexHome
          prompt={homePrompt}
          busy={busy}
          projects={projects}
          selectedProjectId={homeProjectId}
          settings={appSettings}
          modelLabel={describeLlm(appSettings)}
          onPromptChange={setHomePrompt}
          onProjectSelect={setHomeProjectId}
          onModelSelect={selectHomeModel}
          onSubmit={startHomeConversation}
        />
      ) : null}
      {activeTab === "aetherops" && snapshot && projectView === "dashboard" ? (
        <AetherOpsTab
          input={input}
          setInput={setInput}
          snapshot={snapshot}
          events={events}
          metrics={metrics}
          busy={busy}
          onCreate={createExactWorkflow}
          onStart={startLoop}
          onPause={pauseLoop}
          onResume={resumeLoop}
          onAbort={abortLoop}
        />
      ) : null}
      {activeTab === "aetherops" && snapshot && projectView === "chat" ? (
        <ProjectChatTab
          snapshot={snapshot}
          selectedSessionId={selectedSessionId}
          prompt={chatPrompt}
          error={chatError}
          pendingMessage={pendingChatMessage}
          busy={busy}
          settings={appSettings}
          modelLabel={describeLlm(appSettings)}
          onPromptChange={setChatPrompt}
          onModelSelect={selectHomeModel}
          onSubmit={submitChatPrompt}
        />
      ) : null}
      {activeTab !== "aetherops" && activeTab !== "settings" && activeTab !== "new-chat" ? <CodexPlaceholder activeTab={activeTab} /> : null}
      {activeTab === "settings" && settingsDraft ? (
        <SettingsTab
          appSettings={appSettings}
          settingsDraft={settingsDraft}
          settingsMessage={settingsMessage}
          apiKeyInput={apiKeyInput}
          webKeyInput={webKeyInput}
          embeddingKeyInput={embeddingKeyInput}
          openCodeAuthProvider={openCodeAuthProvider}
          openCodeAuthOutput={openCodeAuthOutput}
          onSave={saveSettings}
          onOpenCodeAuthProviderChange={setOpenCodeAuthProvider}
          onOpenCodeOAuthLogin={loginOpenCodeOAuth}
          onOpenCodeAuthList={refreshOpenCodeAuthList}
          onSettingsDraftChange={(next) => {
            setSettingsDraft(next);
            setSettingsMessage("");
          }}
          onApiKeyInputChange={setApiKeyInput}
          onWebKeyInputChange={setWebKeyInput}
          onEmbeddingKeyInputChange={setEmbeddingKeyInput}
        />
      ) : null}
    </main>
  );
}

function CodexSidebar({
  activeTab,
  projects,
  snapshot,
  selectedSessionId,
  projectView,
  sessionTitle,
  busy,
  onTabChange,
  onSelectProject,
  onSelectDashboard,
  onSelectSession,
  onSessionTitleChange,
  onCreateChatSession,
  onDeleteSession,
  onCreateResearchProject,
  onNewChat
}: {
  activeTab: SidebarTab;
  projects: ResearchProject[];
  snapshot?: ResearchSnapshot;
  selectedSessionId?: string;
  projectView: ProjectView;
  sessionTitle: string;
  busy: boolean;
  onTabChange: (tab: SidebarTab) => void;
  onSelectProject: (projectId: string) => Promise<void>;
  onSelectDashboard: () => void;
  onSelectSession: (sessionId: string) => void;
  onSessionTitleChange: (value: string) => void;
  onCreateChatSession: () => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onCreateResearchProject: () => Promise<void>;
  onNewChat: () => void;
}): ReactElement {
  return (
    <aside className="codexSidebar">
      <div className="codexChrome">
        <span className="windowDot" />
        <span className="backArrow">←</span>
        <span className="backArrow muted">→</span>
      </div>

      <nav className="codexNav">
        <SidebarButton active={activeTab === "new-chat"} icon={MessageSquare} label="새 채팅" onClick={onNewChat} />
        <SidebarButton active={activeTab === "search"} icon={Search} label="검색" onClick={() => onTabChange("search")} />
        <SidebarButton active={activeTab === "plugins"} icon={Wrench} label="플러그인" onClick={() => onTabChange("plugins")} />
        <SidebarButton active={activeTab === "automation"} icon={Gauge} label="자동화" onClick={() => onTabChange("automation")} />
      </nav>

      <section className="codexSection projectSection">
        <div className="codexSectionTitle">프로젝트</div>
        <button className="projectCreateButton" type="button" onClick={() => void onCreateResearchProject()} disabled={busy}>
          {busy ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
          새 연구 프로젝트
        </button>
        <div className="projectList">
          {projects.length ? (
            projects.map((project) => {
              const selected = snapshot?.project.id === project.id;
              return (
                <div key={project.id} className={`projectGroup ${selected ? "selected" : ""}`}>
                  <button className="projectFolderHeader" type="button" onClick={() => void onSelectProject(project.id)}>
                    <Folder size={16} />
                    <span>{project.topic}</span>
                    <small>{projectAge(project.createdAt)}</small>
                  </button>
                  {selected ? (
                    <div className="sessionList">
                      <button
                        className={`codexConversation ${projectView === "dashboard" ? "active" : ""}`}
                        type="button"
                        onClick={onSelectDashboard}
                      >
                        <span>전체 관제 화면</span>
                        <small>{projectAge(project.createdAt)}</small>
                      </button>
                      {chatSessionsFor(snapshot).map((session) => (
                        <div
                          key={session.id}
                          className={`sessionRow ${projectView === "chat" && selectedSessionId === session.id ? "active" : ""}`}
                        >
                          <button className="sessionSelectButton" type="button" onClick={() => onSelectSession(session.id)}>
                            <span>{session.title}</span>
                            <small>{projectAge(session.createdAt)}</small>
                          </button>
                          <button
                            className="sessionDeleteButton"
                            type="button"
                            title="세션 삭제"
                            onClick={() => void onDeleteSession(session.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      <div className="sessionCreator">
                        <input
                          value={sessionTitle}
                          placeholder="새 채팅 세션"
                          onChange={(event) => onSessionTitleChange(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void onCreateChatSession();
                            }
                          }}
                        />
                        <button type="button" onClick={() => void onCreateChatSession()}>
                          <Plus size={15} />
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <p className="sidebarEmpty">아직 프로젝트가 없습니다.</p>
          )}
        </div>
      </section>

      <button className={`codexSettings ${activeTab === "settings" ? "active" : ""}`} type="button" onClick={() => onTabChange("settings")}>
        <Settings size={17} />
        설정
      </button>
    </aside>
  );
}

function SidebarButton({
  active,
  icon: Icon,
  label,
  onClick
}: {
  active: boolean;
  icon: IconComponent;
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button className={`codexNavItem ${active ? "active" : ""}`} type="button" onClick={onClick}>
      <Icon size={17} />
      <span>{label}</span>
    </button>
  );
}

function CodexHome({
  prompt,
  busy,
  projects,
  selectedProjectId,
  settings,
  modelLabel,
  onPromptChange,
  onProjectSelect,
  onModelSelect,
  onSubmit
}: {
  prompt: string;
  busy: boolean;
  projects: ResearchProject[];
  selectedProjectId: string;
  settings?: AppSettings;
  modelLabel: string;
  onPromptChange: (value: string) => void;
  onProjectSelect: (projectId: string) => void;
  onModelSelect: (selection: HomeModelSelection) => Promise<void>;
  onSubmit: () => Promise<void>;
}): ReactElement {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  async function chooseModel(selection: HomeModelSelection): Promise<void> {
    await onModelSelect(selection);
    setModelMenuOpen(false);
  }

  return (
    <section className="codexHome">
      <div className="homeCenter">
        <h1>AetherOps에서 무엇을 구축할까요?</h1>
        <div className="homePromptCard">
          <textarea
            className="homePromptInput"
            value={prompt}
            placeholder="연구 목표를 적어주세요. 예: 포모도로 25/5와 50/10을 근거 기반으로 비교"
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => submitOnEnter(event, onSubmit)}
          />
          <div className="homePromptToolbar">
            <div className="homeToolGroup">
              <button type="button" className="ghostButton">
                <Paperclip size={16} />
              </button>
            </div>
            <div className="homeToolGroup">
              <div className="modelPickerHost">
                <button className="homeModelButton" type="button" onClick={() => setModelMenuOpen((open) => !open)}>
                {modelLabel}
                  <ChevronDown size={14} />
                </button>
                {modelMenuOpen ? <HomeModelPicker settings={settings} onSelect={(selection) => void chooseModel(selection)} /> : null}
              </div>
              <button className="homeSendButton" type="button" onClick={() => void onSubmit()} disabled={!prompt.trim() || busy}>
                {busy ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
              </button>
            </div>
          </div>
          <div className="homeContextBar">
            <label className="homeProjectSelect">
              <FolderKanban size={14} />
              <select value={selectedProjectId} onChange={(event) => onProjectSelect(event.target.value)}>
                <option value="">새 연구 프로젝트</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.topic}
                  </option>
                ))}
              </select>
            </label>
            <span>
              <HardDrive size={14} /> 로컬에서 작업
            </span>
            <span>
              <GitBranch size={14} /> main
            </span>
          </div>
        </div>

        <div className="homeCards">
          <HomeCard icon={FolderKanban} title="연구 DB 준비" copy="목표, 범위, 예산, 자율성 정책을 한 번에 설정" />
          <HomeCard icon={MessageSquare} title="채팅 세션 생성" copy="프로젝트 안에서 주제별 대화 세션 구성" />
          <HomeCard icon={Database} title="자료 연결" copy="결과, 조사, 계획을 DB와 RAG에 저장" />
        </div>
      </div>
    </section>
  );
}

function ProjectChatTab({
  snapshot,
  selectedSessionId,
  prompt,
  error,
  pendingMessage,
  busy,
  settings,
  modelLabel,
  onPromptChange,
  onModelSelect,
  onSubmit
}: {
  snapshot: ResearchSnapshot;
  selectedSessionId?: string;
  prompt: string;
  error: string;
  pendingMessage?: PendingChatMessage;
  busy: boolean;
  settings?: AppSettings;
  modelLabel: string;
  onPromptChange: (value: string) => void;
  onModelSelect: (selection: HomeModelSelection) => Promise<void>;
  onSubmit: () => Promise<void>;
}): ReactElement {
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const session = selectedSessionId ? chatSessionsFor(snapshot).find((item) => item.id === selectedSessionId) : undefined;
  const messages = session ? chatMessagesFor(snapshot, session.id, session.title) : [];
  const pendingForSession = session && pendingMessage?.sessionId === session.id ? pendingMessage : undefined;
  const [now, setNow] = useState(Date.now());
  const memoCount = messages.length;
  const hasConversation = messages.length > 0 || Boolean(pendingForSession);

  useEffect(() => {
    if (!pendingForSession) {
      return undefined;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pendingForSession?.startedAt]);

  async function chooseModel(selection: HomeModelSelection): Promise<void> {
    await onModelSelect(selection);
    setModelMenuOpen(false);
  }

  return (
    <section className={`codexHome projectChatHome ${hasConversation ? "chatStarted" : ""}`}>
      <div className="homeCenter">
        <div className="projectChatHeading">
          <p>{snapshot.project.topic}</p>
          <h1>{session?.title ?? "채팅 세션"}</h1>
        </div>
        <div className="chatTranscript">
          {messages.length ? (
            messages.map((message) => (
              <article key={message.id} className={`chatBubble ${chatMessageRole(message)}`}>
                <p>{message.content ?? message.summary}</p>
                <small>{new Date(message.createdAt).toLocaleString()}</small>
              </article>
            ))
          ) : pendingForSession ? null : (
            <div className="chatEmptyState">
              <MessageSquare size={18} />
              <p>아직 이 세션에 저장된 대화가 없습니다.</p>
            </div>
          )}
          {pendingForSession ? (
            <>
              <article className="chatBubble user pending">
                <p>{pendingForSession.content}</p>
                <small>{new Date(pendingForSession.createdAt).toLocaleString()} · 전송 중</small>
              </article>
              <div className="chatWorking">
                <span>{formatWorkingLabel(now, pendingForSession.startedAt)}</span>
                <p>생각 중...</p>
              </div>
            </>
          ) : null}
        </div>
        {error ? <div className="chatErrorBanner">{error}</div> : null}
        <div className="homePromptCard compactPromptCard">
          <textarea
            className="homePromptInput"
            value={prompt}
            placeholder="이 연구 세션에서 무엇을 조사할까요?"
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => submitOnEnter(event, onSubmit)}
          />
          <div className="homePromptToolbar">
            <div className="homeToolGroup">
              <button type="button" className="ghostButton" title="자료 첨부">
                <Paperclip size={16} />
              </button>
            </div>
            <div className="homeToolGroup">
              <div className="modelPickerHost">
                <button className="homeModelButton" type="button" onClick={() => setModelMenuOpen((open) => !open)}>
                  {modelLabel}
                  <ChevronDown size={14} />
                </button>
                {modelMenuOpen ? <HomeModelPicker settings={settings} onSelect={(selection) => void chooseModel(selection)} /> : null}
              </div>
              <button className="homeSendButton" type="button" onClick={() => void onSubmit()} disabled={!session || !prompt.trim() || busy}>
                {busy ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
              </button>
            </div>
          </div>
          <div className="homeContextBar">
            <span>
              <FolderKanban size={14} /> {snapshot.project.topic}
            </span>
            <span>
              <MessageSquare size={14} /> {session?.title ?? "채팅 세션"}
            </span>
            <span>
              <FileText size={14} /> 메모 {memoCount}
            </span>
          </div>
        </div>

        <div className="homeCards chatSessionCards">
          <HomeCard icon={MessageSquare} title="연구 대화" copy="질문, 아이디어, 결정 사항을 대화 메모로 저장합니다." />
          <HomeCard icon={Database} title="프로젝트 DB 연결" copy="저장된 메모는 프로젝트 연구 DB와 RAG 자료로 이어집니다." />
          <HomeCard icon={Workflow} title="관제 화면 연동" copy="전체 관제 화면에서 루프 단계와 산출물을 계속 추적합니다." />
        </div>
      </div>
    </section>
  );
}

function HomeModelPicker({
  settings,
  onSelect
}: {
  settings?: AppSettings;
  onSelect: (selection: HomeModelSelection) => void;
}): ReactElement {
  const activeSource = settings?.openCodeLlm.source ?? "codex-oauth";
  const activeProvider = settings?.openCodeLlm.source === "api" ? settings.openCodeLlm.provider : "openai";
  const activeModel =
    settings?.openCodeLlm.source === "api" ? settings.openCodeLlm.model : settings?.openCodeLlm.model ?? codexOAuthModels[0];
  const [provider, setProvider] = useState<OpenCodeApiLlmSettings["provider"] | "codex-oauth">(
    activeSource === "codex-oauth" ? "codex-oauth" : activeProvider
  );
  const providerRows: Array<{ id: OpenCodeApiLlmSettings["provider"] | "codex-oauth"; label: string; source: string }> = [
    { id: "codex-oauth", label: "Codex OAuth", source: "OAuth" },
    { id: "openai", label: "OpenAI", source: "API" },
    { id: "anthropic", label: "Anthropic", source: "API" },
    { id: "google", label: "Google", source: "API" },
    { id: "custom", label: "기타 모델", source: "API" }
  ];
  const models = provider === "codex-oauth" ? codexOAuthModels : modelOptions[provider];

  return (
    <div className="modelPickerPopover">
      <div className="modelPickerPanel">
        <p className="modelPickerTitle">연결</p>
        {providerRows.map((row) => (
          <button
            key={row.id}
            className={`modelPickerRow ${provider === row.id ? "selected" : ""}`}
            type="button"
            onClick={() => setProvider(row.id)}
          >
            <span>
              <strong>{row.label}</strong>
              <small>{row.source}</small>
            </span>
            {provider === row.id ? <Check size={16} /> : null}
          </button>
        ))}
      </div>
      <div className="modelPickerPanel modelPickerModels">
        <p className="modelPickerTitle">모델</p>
        {models.map((model) => {
          const selected =
            activeModel === model &&
            ((provider === "codex-oauth" && activeSource === "codex-oauth") ||
              (provider !== "codex-oauth" && activeSource === "api" && activeProvider === provider));
          return (
            <button
              key={model}
              className={`modelPickerRow ${selected ? "selected" : ""}`}
              type="button"
              onClick={() =>
                onSelect(provider === "codex-oauth" ? { source: "codex-oauth", model } : { source: "api", provider, model })
              }
            >
              <strong>{formatModelName(model)}</strong>
              {selected ? <Check size={16} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HomeCard({ icon: Icon, title, copy }: { icon: IconComponent; title: string; copy: string }): ReactElement {
  return (
    <article className="homeCard">
      <Icon size={20} />
      <h2>{title}</h2>
      <p>{copy}</p>
    </article>
  );
}

function AetherOpsTab({
  input,
  setInput,
  snapshot,
  events,
  metrics,
  busy,
  onCreate,
  onStart
}: {
  input: ResearchProjectInput;
  setInput: (input: ResearchProjectInput) => void;
  snapshot: ResearchSnapshot;
  events: LoopIteration[];
  metrics: Array<{ label: string; value: number }>;
  busy: boolean;
  onCreate: () => Promise<void>;
  onStart: () => Promise<void>;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onAbort: () => Promise<void>;
}): ReactElement {
  const currentStep = snapshot.project.currentStep;
  const latestResult = snapshot.results.at(-1);
  const activeRun = snapshot.openCodeRuns.at(-1);
  const latestRag = snapshot.ragContexts.at(-1);
  const latestHybrid = snapshot.hybridContexts.at(-1);
  const latestPlan = snapshot.researchPlans.at(-1);
  const latestSpec = snapshot.specifications.at(-1);
  const latestDecision = snapshot.continuationDecisions.at(-1);
  const memoryItems = [
    { label: "Raw Sources", value: snapshot.sources.length },
    { label: "Artifacts", value: snapshot.artifacts.length },
    { label: "Tool Logs", value: snapshot.toolRuns.length + snapshot.openCodeRuns.length },
    { label: "Evidence Ledger", value: snapshot.evidence.length + snapshot.normalizedRecords.filter((record) => record.kind === "evidence").length },
    { label: "Vector DB", value: snapshot.chunks.length },
    { label: "Ontology Graph DB", value: snapshot.ontologyEntities.length + snapshot.ontologyRelations.length },
    { label: "Projects & Reports", value: snapshot.finalOutputs.length + (snapshot.report ? 1 : 0) }
  ];
  const renderStepTile = (step: ResearchLoopStep): ReactElement => {
    const meta = stepLabels[step];
    const Icon = meta.icon;
    const active = currentStep === step;
    const visited = snapshot.iterations.some((iteration) => iteration.step === step);
    return (
      <div key={step} className={`stepTile ${meta.flow} ${active ? "active" : ""} ${visited ? "visited" : ""}`}>
        <div className="stepIndex">{meta.index}</div>
        <Icon size={21} />
        <span>{meta.label}</span>
      </div>
    );
  };

  return (
    <section className="codexContent">
      <header className="codexTopbar">
        <div>
          <p className="eyebrow">Main Flow / Data Flow / Agent Control / Knowledge Flow</p>
          <h1>{snapshot.project.topic}</h1>
        </div>
        <div className={`statusPill ${snapshot.project.status}`}>{statusLabel(snapshot.project.status)}</div>
      </header>

      <section className="projectComposer">
        <div className="composerFields">
          <label>
            목표
            <textarea value={input.goal} onChange={(event) => setInput({ ...input, goal: event.target.value })} />
          </label>
          <div className="fieldGrid">
            <label>
              주제
              <input value={input.topic} onChange={(event) => setInput({ ...input, topic: event.target.value })} />
            </label>
            <label>
              예산/제약
              <input value={input.budget} onChange={(event) => setInput({ ...input, budget: event.target.value })} />
            </label>
          </div>
          <label>
            범위
            <textarea value={input.scope} onChange={(event) => setInput({ ...input, scope: event.target.value })} />
          </label>
        </div>
        <div className="composerSide">
          <label>
            반복
            <NumberSelect
              value={input.autonomyPolicy.maxLoopIterations}
              options={maxLoopIterationOptions}
              onChange={(maxLoopIterations) => setInput({ ...input, autonomyPolicy: { ...input.autonomyPolicy, maxLoopIterations } })}
            />
          </label>
          <label>
            승인
            <select
              value={input.autonomyPolicy.toolApproval}
              onChange={(event) =>
                setInput({
                  ...input,
                  autonomyPolicy: { ...input.autonomyPolicy, toolApproval: event.target.value as ResearchProjectInput["autonomyPolicy"]["toolApproval"] }
                })
              }
            >
              <option value="manual">수동</option>
              <option value="suggested">제안 후 실행</option>
              <option value="automatic">자동</option>
            </select>
          </label>
          <button className="primaryButton" onClick={onStart} disabled={busy} type="button">
            {busy ? <Loader2 className="spin" size={17} /> : <FolderKanban size={17} />}
            연구 루프 시작
          </button>
        </div>
      </section>

      <section className="flowBoard flowBoardStructured">
        <div className="flowGroup design">
          <h2>연구 설계</h2>
          <div className="flowGroupGrid">{designSteps.map(renderStepTile)}</div>
        </div>
        <div className="flowGroup loop">
          <div className="flowGroupHeader">
            <h2>연구 실행 및 분석 반복 루프</h2>
            <span>11에서 계속이면 4번 연구 계획 수립으로 복귀</span>
          </div>
          <div className="flowGroupGrid loopGrid">{loopSteps.map(renderStepTile)}</div>
        </div>
        <div className="flowGroup decision">
          <h2>루프 판단 및 최종 산출</h2>
          <div className="flowGroupGrid decisionGrid">{decisionSteps.map(renderStepTile)}</div>
        </div>
        <div className="memoryLayer">
          <div>
            <h2>Persistent Research Memory</h2>
            <p>NormalizeData 이후 Vector Index와 Ontology Graph를 병렬 지식화 계층으로 보관합니다.</p>
          </div>
          <div className="memoryGrid">
            {memoryItems.map((item) => (
              <div key={item.label} className="memoryItem">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="metricStrip">
        {metrics.map((metric) => (
          <div key={metric.label} className="metricItem">
            <strong>{metric.value}</strong>
            <span>{metric.label}</span>
          </div>
        ))}
      </section>

      <div className="contentGrid">
        <section className="panel wide">
          <div className="panelTitle">
            <Bot size={17} />
            <h2>AetherOps 연구 에이전트</h2>
          </div>
          <div className="agentMatrix">
            <AgentDuty icon={Target} label="계획 및 의사결정" />
            <AgentDuty icon={Wrench} label="도구 선택 및 실행" />
            <AgentDuty icon={FileText} label="결과 해석 및 요약" />
            <AgentDuty icon={GitBranch} label="질문/가설 업데이트" />
            <AgentDuty icon={Workflow} label="다음 단계 제안" />
          </div>
          <div className="latestResult">
            <h3>근거 기반 결과</h3>
            <p>{latestResult?.answer ?? "루프를 실행하면 Hybrid Retrieval과 citation 기반 결과가 표시됩니다."}</p>
          </div>
          <div className="latestResult">
            <h3>현재 연구 명세</h3>
            <p>{latestSpec ? latestSpec.researchQuestions.slice(0, 3).join(" / ") : "아직 연구 명세가 없습니다."}</p>
          </div>
          <div className="latestResult">
            <h3>현재 연구 계획</h3>
            <p>{latestPlan ? latestPlan.objective : "아직 연구 계획이 없습니다."}</p>
          </div>
        </section>

        <section className="panel">
          <div className="panelTitle">
            <History size={17} />
            <h2>최근 이벤트</h2>
          </div>
          <div className="eventList">
            {events.length ? (
              events.map((event) => (
                <div key={event.id} className="eventRow">
                  <span>{event.flowKind}</span>
                  <p>{event.message}</p>
                </div>
              ))
            ) : (
              <p className="empty">아직 이벤트가 없습니다.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panelTitle">
            <Database size={17} />
            <h2>연구 DB 저장 내용</h2>
          </div>
          <StorageList snapshot={snapshot} />
        </section>

        <section className="panel">
          <div className="panelTitle">
            <Bot size={17} />
            <h2>OpenCode / Tool 로그</h2>
          </div>
          <div className="runBox">
            <h3>{activeRun?.toolPlan.join(" / ") || "대기"}</h3>
            {(activeRun?.logs ?? ["아직 실행 로그가 없습니다."]).map((log) => (
              <p key={log}>{log}</p>
            ))}
            {snapshot.toolRuns.slice(-4).map((toolRun) => (
              <p key={toolRun.id}>
                [{toolRun.status}] {toolRun.toolName} {toolRun.error ? `- ${toolRun.error}` : ""}
              </p>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panelTitle">
            <Search size={17} />
            <h2>Hybrid 근거 패널</h2>
          </div>
          <div className="ragBox">
            <p>{latestHybrid?.contextText ?? latestRag?.summary ?? "아직 검색 컨텍스트가 구성되지 않았습니다."}</p>
            <span>
              chunk {latestHybrid?.vectorChunkIds.length ?? latestRag?.chunkIds?.length ?? 0} / citation {latestHybrid?.citations.length ?? latestRag?.citations?.length ?? 0}
            </span>
          </div>
        </section>

        <section className="panel wide">
          <div className="panelTitle">
            <CheckCircle2 size={17} />
            <h2>최종 결과 도출</h2>
          </div>
          <div className="finalGrid">
            <FinalItem title="Answer" value={snapshot.report?.answer} />
            <FinalItem title="Hypothesis verification" value={snapshot.report?.hypothesisVerification} />
            <FinalItem title="Quantitative / qualitative" value={snapshot.report?.quantitativeQualitativeResults} />
            <FinalItem title="Continuation decision" value={latestDecision ? (latestDecision.shouldContinue ? "Continue - " : "Finalize - ") + latestDecision.reason : undefined} />
            <FinalItem title="Comprehensive report" value={snapshot.report?.comprehensiveReport} />
            <FinalItem title="Reusable knowledge" value={snapshot.report?.reusableKnowledgeAsset} />
          </div>
        </section>
      </div>
    </section>
  );
}

function CodexPlaceholder({ activeTab }: { activeTab: SidebarTab }): ReactElement {
  const labels: Record<SidebarTab, string> = {
    aetherops: "AetherOps",
    "new-chat": "새 채팅",
    search: "검색",
    plugins: "플러그인",
    automation: "자동화",
    settings: "설정"
  };
  return (
    <section className="codexPlaceholder">
      <div className="placeholderCard">
        <h1>{labels[activeTab]}</h1>
        <p>이 영역은 이후 AetherOps 프로젝트 자료와 연결될 예정입니다. 연구 프로젝트는 왼쪽 사이드바 또는 첫 화면에서 생성할 수 있습니다.</p>
      </div>
    </section>
  );
}

function SettingsTab({
  appSettings,
  settingsDraft,
  settingsMessage,
  apiKeyInput,
  webKeyInput,
  embeddingKeyInput,
  openCodeAuthProvider,
  openCodeAuthOutput,
  onSave,
  onOpenCodeAuthProviderChange,
  onOpenCodeOAuthLogin,
  onOpenCodeAuthList,
  onSettingsDraftChange,
  onApiKeyInputChange,
  onWebKeyInputChange,
  onEmbeddingKeyInputChange
}: {
  appSettings?: AppSettings;
  settingsDraft: AppSettings;
  settingsMessage: string;
  apiKeyInput: string;
  webKeyInput: string;
  embeddingKeyInput: string;
  openCodeAuthProvider: string;
  openCodeAuthOutput: string;
  onSave: () => Promise<void>;
  onOpenCodeAuthProviderChange: (provider: string) => void;
  onOpenCodeOAuthLogin: () => Promise<void>;
  onOpenCodeAuthList: () => Promise<void>;
  onSettingsDraftChange: (settings: AppSettings) => void;
  onApiKeyInputChange: (value: string) => void;
  onWebKeyInputChange: (value: string) => void;
  onEmbeddingKeyInputChange: (value: string) => void;
}): ReactElement {
  return (
    <section className="codexContent settingsTab">
      <header className="settingsWindowHeader">
        <div>
          <p className="eyebrow">Provider / API Keys / Runtime</p>
          <h1 id="settings-window-title">설정</h1>
          <p className="settingsSubcopy">AetherOps API, LLM, OpenCode OAuth, 검색, RAG 설정을 관리합니다.</p>
        </div>
      </header>

      <div className="settingsWindowGrid">
        <section className="settingsGroup">
          <div className="panelTitle">
            <Bot size={17} />
            <h3>오케스트레이터 LLM</h3>
          </div>
          <label>
            현재 모델
            <input readOnly value={describeLlm(settingsDraft)} />
          </label>
          <p className="settingsHint">모델은 첫 화면 입력창의 모델 버튼에서 선택합니다.</p>

          {settingsDraft.openCodeLlm.source === "api" ? (
            <>
              <label>
                Base URL
                <StringSelect
                  value={settingsDraft.openCodeLlm.baseUrl ?? ""}
                  options={["", "https://api.openai.com/v1", "https://generativelanguage.googleapis.com/v1beta/openai", "http://localhost:11434/v1"]}
                  onChange={(baseUrl) =>
                    onSettingsDraftChange({
                      ...settingsDraft,
                      openCodeLlm:
                        settingsDraft.openCodeLlm.source === "api" ? { ...settingsDraft.openCodeLlm, baseUrl } : settingsDraft.openCodeLlm
                    })
                  }
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  placeholder={settingsDraft.openCodeLlm.apiKeyConfigured ? "이미 저장됨. 새 값만 입력" : "API key 입력"}
                  value={apiKeyInput}
                  onChange={(event) => onApiKeyInputChange(event.target.value)}
                />
              </label>
            </>
          ) : (
            <p className="settingsHint">Codex OAuth 모델은 홈의 모델 버튼에서 바로 바꿀 수 있습니다.</p>
          )}
        </section>

        <section className="settingsGroup">
          <div className="panelTitle">
            <Workflow size={17} />
            <h3>OpenCode 도구 엔진</h3>
          </div>
          <div className="fieldGrid">
            <label>
              사용 여부
              <select
                value={settingsDraft.openCode.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({ ...settingsDraft, openCode: { ...settingsDraft.openCode, enabled: event.target.value === "true" } })
                }
              >
                <option value="true">활성화</option>
                <option value="false">비활성화</option>
              </select>
            </label>
            <label>
              Timeout(ms)
              <NumberSelect
                value={settingsDraft.openCode.timeoutMs}
                options={openCodeTimeoutOptions}
                onChange={(timeoutMs) => onSettingsDraftChange({ ...settingsDraft, openCode: { ...settingsDraft.openCode, timeoutMs } })}
              />
            </label>
          </div>
          <label>
            Command / Path
            <StringSelect
              value={settingsDraft.openCode.command}
              options={openCodeCommandOptions}
              onChange={(command) => onSettingsDraftChange({ ...settingsDraft, openCode: { ...settingsDraft.openCode, command } })}
            />
          </label>
          <div className="fieldGrid">
            <label>
              Provider
              <StringSelect
                value={settingsDraft.openCode.provider ?? ""}
                options={openCodeProviderOptions}
                onChange={(provider) => onSettingsDraftChange({ ...settingsDraft, openCode: { ...settingsDraft.openCode, provider } })}
              />
            </label>
            <label>
              현재 모델
              <input readOnly value={settingsDraft.openCode.model ?? describeLlm(settingsDraft)} />
            </label>
          </div>
          <div className="authBox">
            <div className="fieldGrid">
              <label>
                OAuth provider
                <StringSelect value={openCodeAuthProvider} options={openCodeOAuthProviderOptions} onChange={onOpenCodeAuthProviderChange} />
              </label>
              <label>
                인증 명령
                <select value="opencode auth login" disabled>
                  <option value="opencode auth login">opencode auth login</option>
                </select>
              </label>
            </div>
            <div className="settingsActions">
              <button type="button" onClick={onOpenCodeOAuthLogin}>
                <KeyRound size={16} />
                OpenCode OAuth 로그인
              </button>
              <button type="button" onClick={onOpenCodeAuthList}>
                인증 상태 확인
              </button>
            </div>
            {openCodeAuthOutput ? <pre className="authOutput">{openCodeAuthOutput}</pre> : null}
          </div>
        </section>

        <section className="settingsGroup">
          <div className="panelTitle">
            <Globe2 size={17} />
            <h3>검색 API</h3>
          </div>
          <div className="fieldGrid">
            <label>
              외부 검색
              <select
                value={settingsDraft.allowExternalSearch ? "true" : "false"}
                onChange={(event) => onSettingsDraftChange({ ...settingsDraft, allowExternalSearch: event.target.value === "true" })}
              >
                <option value="true">허용</option>
                <option value="false">차단</option>
              </select>
            </label>
            <label>
              Provider
              <select
                value={settingsDraft.webSearch.provider}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    webSearch: { ...settingsDraft.webSearch, provider: event.target.value as AppSettings["webSearch"]["provider"] }
                  })
                }
              >
                <option value="disabled">disabled</option>
                <option value="tavily">tavily</option>
                <option value="brave">brave</option>
                <option value="custom">custom</option>
              </select>
            </label>
          </div>
          <label>
            API key
            <input
              type="password"
              placeholder={settingsDraft.webSearch.apiKeyConfigured ? "이미 저장됨. 새 값만 입력" : "선택 사항"}
              value={webKeyInput}
              onChange={(event) => onWebKeyInputChange(event.target.value)}
            />
          </label>
          <label>
            Custom endpoint
            <StringSelect
              value={settingsDraft.webSearch.endpoint ?? ""}
              options={["", "https://api.tavily.com/search", "https://api.search.brave.com/res/v1/web/search"]}
              onChange={(endpoint) => onSettingsDraftChange({ ...settingsDraft, webSearch: { ...settingsDraft.webSearch, endpoint } })}
            />
          </label>
        </section>

        <section className="settingsGroup">
          <div className="panelTitle">
            <Database size={17} />
            <h3>Embedding / RAG</h3>
          </div>
          <div className="fieldGrid">
            <label>
              Provider
              <select
                value={settingsDraft.embedding.provider}
                onChange={(event) => {
                  const provider = event.target.value as AppSettings["embedding"]["provider"];
                  onSettingsDraftChange({
                    ...settingsDraft,
                    embedding: { ...settingsDraft.embedding, provider, model: embeddingModelOptions[provider][0] }
                  });
                }}
              >
                <option value="local">local hash</option>
                <option value="openai">openai</option>
                <option value="google">google</option>
                <option value="custom">custom</option>
              </select>
            </label>
            <label>
              차원
              <NumberSelect
                value={settingsDraft.embedding.dimensions}
                options={embeddingDimensionOptions}
                onChange={(dimensions) => onSettingsDraftChange({ ...settingsDraft, embedding: { ...settingsDraft.embedding, dimensions } })}
              />
            </label>
          </div>
          <label>
            임베딩 모델
            <StringSelect
              value={settingsDraft.embedding.model ?? embeddingModelOptions[settingsDraft.embedding.provider][0]}
              options={embeddingModelOptions[settingsDraft.embedding.provider]}
              onChange={(model) => onSettingsDraftChange({ ...settingsDraft, embedding: { ...settingsDraft.embedding, model } })}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              placeholder={settingsDraft.embedding.apiKeyConfigured ? "이미 저장됨. 새 값만 입력" : "local hash는 key 불필요"}
              value={embeddingKeyInput}
              onChange={(event) => onEmbeddingKeyInputChange(event.target.value)}
            />
          </label>
        </section>

        <section className="settingsGroup settingsGroupWide">
          <div className="panelTitle">
            <Gauge size={17} />
            <h3>전역 실행 정책</h3>
          </div>
          <div className="fieldGrid three">
            <label>
              최대 반복
              <NumberSelect
                value={settingsDraft.maxLoopIterations}
                options={maxLoopIterationOptions}
                onChange={(maxLoopIterations) => onSettingsDraftChange({ ...settingsDraft, maxLoopIterations })}
              />
            </label>
            <label>
              코드 실행
              <select
                value={settingsDraft.allowCodeExecution ? "true" : "false"}
                onChange={(event) => onSettingsDraftChange({ ...settingsDraft, allowCodeExecution: event.target.value === "true" })}
              >
                <option value="false">비활성화</option>
                <option value="true">활성화</option>
              </select>
            </label>
            <label>
              저장 상태
              <input readOnly value={settingsStatus(appSettings)} />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              Ontology extraction
              <select
                value={settingsDraft.ontologyExtractionMode ?? "rule_based"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    ontologyExtractionMode: event.target.value as NonNullable<AppSettings["ontologyExtractionMode"]>
                  })
                }
              >
                <option value="rule_based">rule_based</option>
                <option value="hybrid">hybrid</option>
                <option value="llm">llm</option>
              </select>
            </label>
            <label>
              Final exports
              <select
                value={settingsDraft.finalOutputExport?.artifactPackage === false ? "report-only" : "full"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    finalOutputExport:
                      event.target.value === "full"
                        ? { markdown: true, json: true, ontologyGraph: true, artifactPackage: true }
                        : { markdown: true, json: true, ontologyGraph: false, artifactPackage: false }
                  })
                }
              >
                <option value="full">full package</option>
                <option value="report-only">report only</option>
              </select>
            </label>
          </div>
        </section>
      </div>

      <footer className="settingsWindowFooter">
        <p className="settingsHint">{settingsMessage || "API key는 저장 시 안전 저장소가 가능하면 암호화됩니다."}</p>
        <div className="settingsFooterActions">
          <button className="primaryButton" onClick={onSave} type="button">
            <Save size={16} />
            저장
          </button>
        </div>
      </footer>
    </section>
  );
}

function StringSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }): ReactElement {
  const normalizedOptions = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {normalizedOptions.map((option) => (
        <option key={option || "empty"} value={option}>
          {option || "선택 사항"}
        </option>
      ))}
    </select>
  );
}

function NumberSelect({ value, options, onChange }: { value: number; options: number[]; onChange: (value: number) => void }): ReactElement {
  const normalizedOptions = options.includes(value) ? options : [value, ...options].sort((left, right) => left - right);
  return (
    <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {normalizedOptions.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function AgentDuty({ icon: Icon, label }: { icon: IconComponent; label: string }): ReactElement {
  return (
    <div className="duty">
      <Icon size={16} />
      <span>{label}</span>
    </div>
  );
}

function StorageList({ snapshot }: { snapshot: ResearchSnapshot }): ReactElement {
  const rows = [
    { icon: FileText, label: "Raw Sources", value: snapshot.sources.length },
    { icon: Boxes, label: "Artifacts", value: snapshot.artifacts.length },
    { icon: Gauge, label: "Tool Logs", value: snapshot.toolRuns.length },
    { icon: MessageSquare, label: "Evidence Ledger", value: snapshot.evidence.length },
    { icon: Search, label: "Vector DB", value: snapshot.chunks.length },
    { icon: Workflow, label: "Ontology Graph DB", value: snapshot.ontologyEntities.length + snapshot.ontologyRelations.length },
    { icon: Database, label: "Projects & Reports", value: snapshot.finalOutputs.length || (snapshot.report ? 1 : 0) }
  ];

  return (
    <div className="storageList">
      {rows.map((row) => {
        const Icon = row.icon;
        return (
          <div key={row.label} className="storageRow">
            <Icon size={16} />
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        );
      })}
    </div>
  );
}

function FinalItem({ title, value }: { title: string; value?: string }): ReactElement {
  return (
    <article className="finalItem">
      <h3>{title}</h3>
      <p>{value ?? "대기"}</p>
    </article>
  );
}

function chatSessionsFor(snapshot: ResearchSnapshot): ResearchSnapshot["sessions"] {
  return snapshot.sessions.filter((session) => !isLegacyStructuredSession(session.title));
}

function chatMessagesFor(snapshot: ResearchSnapshot, sessionId: string, sessionTitle: string): ResearchSnapshot["artifacts"] {
  return snapshot.artifacts
    .filter((artifact) => {
      const relativePath = artifact.relativePath.replace(/\\/g, "/");
      return (
        artifact.category === "conversation_memo" &&
        (relativePath.includes(`/chat/${sessionId}-`) || artifact.title === `${sessionTitle} 메모`)
      );
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function chatMessageRole(message: ResearchSnapshot["artifacts"][number]): "user" | "assistant" {
  const relativePath = message.relativePath.replace(/\\/g, "/");
  return relativePath.endsWith("-assistant.md") || message.title.endsWith("응답") ? "assistant" : "user";
}

function createPendingChatMessage(sessionId: string, content: string): PendingChatMessage {
  return {
    sessionId,
    content,
    createdAt: new Date().toISOString(),
    startedAt: Date.now()
  };
}

function formatWorkingLabel(now: number, startedAt: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return seconds > 0 ? `${formatElapsedSeconds(seconds)} 동안 작업 중입니다` : "작업 중입니다";
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function submitOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>, onSubmit: () => Promise<void>): void {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
    return;
  }
  event.preventDefault();
  void onSubmit();
}

function readWorkspaceState(): { projectId?: string; sessionId?: string; view?: ProjectView } {
  try {
    const raw = window.localStorage.getItem(workspaceStateKey);
    return raw ? (JSON.parse(raw) as { projectId?: string; sessionId?: string; view?: ProjectView }) : {};
  } catch {
    return {};
  }
}

function rememberWorkspace(projectId: string, view: ProjectView, sessionId?: string): void {
  try {
    window.localStorage.setItem(workspaceStateKey, JSON.stringify({ projectId, view, sessionId }));
  } catch {
    return;
  }
}

function clearWorkspaceState(): void {
  try {
    window.localStorage.removeItem(workspaceStateKey);
  } catch {
    return;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLegacyStructuredSession(title: string): boolean {
  return ["질문/가설 세션", "근거/RAG 세션", "실행/분석 세션"].includes(title);
}

function normalizeSettings(settings: AppSettings): AppSettings {
  if (settings.openCodeLlm.source === "api") {
    const provider = settings.openCodeLlm.provider;
    return {
      ...settings,
      openCodeLlm: {
        ...settings.openCodeLlm,
        model: settings.openCodeLlm.model || modelOptions[provider][0]
      },
      embedding: normalizeEmbedding(settings.embedding)
    };
  }
  return {
    ...settings,
    openCodeLlm: {
      ...settings.openCodeLlm,
      model: settings.openCodeLlm.model || codexOAuthModels[0]
    },
    embedding: normalizeEmbedding(settings.embedding)
  };
}

function normalizeEmbedding(embedding: AppSettings["embedding"]): AppSettings["embedding"] {
  return {
    ...embedding,
    model: embedding.model || embeddingModelOptions[embedding.provider][0],
    dimensions: embedding.dimensions || 96
  };
}

function describeLlm(settings?: AppSettings): string {
  if (!settings) {
    return "로딩 중";
  }
  if (settings.openCodeLlm.source === "codex-oauth") {
    return `Codex OAuth · ${settings.openCodeLlm.model ?? codexOAuthModels[0]}`;
  }
  return `${providerLabels[settings.openCodeLlm.provider]} · ${settings.openCodeLlm.model}`;
}

function formatModelName(model: string): string {
  return model
    .replace(/^openai\//, "")
    .replace(/^anthropic\//, "")
    .replace(/\bgpt\b/i, "GPT")
    .replace(/\bclaude\b/i, "Claude")
    .replace(/\bgemini\b/i, "Gemini");
}

function settingsStatus(settings?: AppSettings): string {
  if (!settings) {
    return "아직 불러오지 않음";
  }
  const date = new Date(settings.updatedAt);
  return Number.isNaN(date.getTime()) ? "저장됨" : `${date.toLocaleString()} 저장됨`;
}

function statusLabel(status: ResearchProject["status"]): string {
  const labels: Record<ResearchProject["status"], string> = {
    idle: "대기",
    running: "실행 중",
    paused: "일시정지",
    aborted: "중단됨",
    completed: "완료",
    failed: "실패"
  };
  return labels[status];
}

function deriveTopic(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "새 연구 프로젝트";
  return firstLine.length > 42 ? `${firstLine.slice(0, 42)}...` : firstLine;
}

function projectAge(createdAt: string): string {
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) {
    return "";
  }
  const days = Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
  if (days < 1) {
    return "오늘";
  }
  if (days < 30) {
    return `${days}일`;
  }
  return `${Math.floor(days / 30)}개월`;
}
