import {
  AlertTriangle,
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
  type ResearchSnapshot,
  type RuntimeToolDiagnostics,
  type EngineeringProgramPreflightResult,
  type EngineeringProgramTarget,
  type EngineeringProgramDirectRunResult
} from "../core/shared/types.js";
import { buildResearchInputPayloadFromBrief } from "../core/input/researchInput.js";
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
interface SnapshotStats {
  results: number;
  evidence: number;
  normalizedRecords: number;
  chunks: number;
  graphItems: number;
  validationResults: number;
  rawSources: number;
  artifacts: number;
  toolLogs: number;
  evidenceLedger: number;
  memoryProjectsAndReports: number;
  storageProjectsAndReports: number;
  errorsAndBlockers: number;
}
interface EngineeringWorkbenchState {
  sourceUrl: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
}

const defaultInput: ResearchProjectInput = {
  goal: "근거 기반 반복 연구 루프가 질문, 가설, 자료, 산출물을 스스로 개선하는지 검증한다.",
  topic: "AetherOps 자율 연구 루프",
  scope: "도구 실행, Vector Index, Ontology Graph, 산출물 저장, blocked/failed 기록을 포함한 운영 12단계 검증",
  budget: "운영 제약",
  autonomyPolicy: {
    toolApproval: "suggested",
    allowExternalSearch: true,
    allowCodeExecution: false,
    maxLoopIterations: 1
  }
};

const defaultGuiLoopLimit = 1;
const maxGuiLoopLimit = 8;

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
  custom: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "claude-sonnet-4-6", "gemini-3-pro-preview", "custom-model"]
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
const openCodeLlmBaseUrlOptions = ["", "https://api.openai.com/v1", "https://generativelanguage.googleapis.com/v1beta/openai", "http://localhost:11434/v1"];
const webSearchEndpointOptions = ["", "https://api.tavily.com/search", "https://api.search.brave.com/res/v1/web/search"];
const researchMetadataMaxResultOptions = [3, 5, 8, 12, 20];
const researchMetadataTimeoutOptions = [5_000, 10_000, 15_000, 30_000, 60_000];
const xfoilCommandOptions = ["", "xfoil", "xfoil.exe"];
const openFoamCommandOptions = ["", "simpleFoam", "icoFoam", "pimpleFoam", "rhoSimpleFoam"];
const su2CommandOptions = ["", "SU2_CFD", "SU2_CFD.exe", "SU2_SOL", "SU2_SOL.exe"];
const freeCadCommandOptions = ["", "FreeCADCmd", "FreeCADCmd.exe", "freecadcmd"];
const openVspCommandOptions = ["", "vsp", "vsp.exe", "vsp_aero", "vsp_aero.exe"];
const engineeringTimeoutOptions = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];
const meshByteLimitOptions = [5 * 1024 * 1024, 20 * 1024 * 1024, 50 * 1024 * 1024, 100 * 1024 * 1024];
const homeModelProviderRows: Array<{ id: OpenCodeApiLlmSettings["provider"] | "codex-oauth"; label: string; source: string }> = [
  { id: "codex-oauth", label: "Codex OAuth", source: "OAuth" },
  { id: "openai", label: "OpenAI", source: "API" },
  { id: "anthropic", label: "Anthropic", source: "API" },
  { id: "google", label: "Google", source: "API" },
  { id: "custom", label: "기타 모델", source: "API" }
];
const emptySessions: ResearchSnapshot["sessions"] = [];
const emptyRunLogs = ["아직 실행 로그가 없습니다."];
const emptySnapshotStats: SnapshotStats = {
  results: 0,
  evidence: 0,
  normalizedRecords: 0,
  chunks: 0,
  graphItems: 0,
  validationResults: 0,
  rawSources: 0,
  artifacts: 0,
  toolLogs: 0,
  evidenceLedger: 0,
  memoryProjectsAndReports: 0,
  storageProjectsAndReports: 0,
  errorsAndBlockers: 0
};
const projectStatusLabels: Record<ResearchProject["status"], string> = {
  idle: "대기",
  running: "실행 중",
  paused: "일시정지",
  aborted: "중단됨",
  completed: "완료",
  failed: "실패",
  blocked: "설정 필요"
};
const sidebarTabLabels: Record<SidebarTab, string> = {
  aetherops: "AetherOps",
  "new-chat": "새 채팅",
  search: "검색",
  plugins: "플러그인",
  automation: "자동화",
  settings: "설정"
};
const embeddingModelOptions: Record<AppSettings["embedding"]["provider"], string[]> = {
  local: ["text-embedding-3-small", "text-embedding-3-large"],
  openai: ["text-embedding-3-small", "text-embedding-3-large"],
  google: ["gemini-embedding-001"],
  custom: ["text-embedding-3-small", "text-embedding-3-large", "gemini-embedding-001", "custom-embedding-model"]
};
const embeddingDimensionOptions = [64, 96, 128, 256, 512, 1024, 1536, 3072];
const defaultEngineeringWorkbench: EngineeringWorkbenchState = {
  sourceUrl: "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat",
  reynolds: 1_000_000,
  mach: 0,
  alphaStart: -2,
  alphaEnd: 6,
  alphaStep: 2
};

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
const legacyStructuredSessionTitles = new Set(["질문/가설 세션", "근거/RAG 세션", "실행/분석 세션"]);

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
  const [toolDiagnostics, setToolDiagnostics] = useState<RuntimeToolDiagnostics>();
  const [engineeringPreflightResult, setEngineeringPreflightResult] = useState<EngineeringProgramPreflightResult>();
  const [engineeringPreflightBusy, setEngineeringPreflightBusy] = useState(false);
  const [engineeringWorkbench, setEngineeringWorkbench] = useState<EngineeringWorkbenchState>(defaultEngineeringWorkbench);
  const [engineeringRunResult, setEngineeringRunResult] = useState<EngineeringProgramDirectRunResult>();
  const [engineeringRunBusy, setEngineeringRunBusy] = useState(false);
  const [engineeringRunMessage, setEngineeringRunMessage] = useState("");
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
          void refreshToolDiagnostics(() => disposed);
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

  useEffect(() => {
    if (activeTab !== "settings") {
      return;
    }

    let disposed = false;
    void api.settings
      .get()
      .then((settings) => {
        if (disposed) {
          return;
        }
        const normalized = normalizeSettings(settings);
        setAppSettings(normalized);
        setSettingsDraft((current) => current ?? normalized);
        void refreshToolDiagnostics(() => disposed);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSettingsMessage(`설정 갱신 실패: ${formatError(error)}`);
        }
      });

    return () => {
      disposed = true;
    };
  }, [activeTab]);

  const snapshotStats = useMemo(() => (snapshot ? buildSnapshotStats(snapshot) : emptySnapshotStats), [snapshot]);
  const metrics = useMemo(() => metricRows(snapshotStats), [snapshotStats]);

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
      setInput(projectInput);
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
          scope: "사용자 프롬프트를 기반으로 연구 DB와 채팅 세션을 구성합니다. 연구 질문과 가설은 명시 입력 후 실행됩니다.",
          budget: "초기 프로젝트"
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
      const runInput = normalizeRunInput(input);
      setInput(runInput);
      let prepared = await api.projects.update(snapshot.project.id, runInput);
      setSnapshot(prepared);
      setEvents(prepared.iterations.slice(-16));
      const payload = buildResearchInputPayloadFromBrief(runInput);
      prepared = await api.research.inputResearchQuestionHypothesis(snapshot.project.id, payload);
      setSnapshot(prepared);
      setEvents(prepared.iterations.slice(-16));
      const next = await api.loop.start(prepared.project.id);
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
    const saved = normalizeSettings(await api.settings.save(settingsToSave(settingsDraft)));
    setAppSettings(saved);
    setSettingsDraft(saved);
    setApiKeyInput("");
    setWebKeyInput("");
    setEmbeddingKeyInput("");
    const diagnosticsReady = await refreshToolDiagnostics(undefined, "설정이 저장되었습니다.");
    if (diagnosticsReady) {
      setSettingsMessage("설정이 저장되었습니다.");
    }
  }

  async function loginOpenCodeOAuth(): Promise<void> {
    const provider = openCodeAuthProvider === "대화형 선택" ? undefined : openCodeAuthProvider;
    const result = await api.opencode.authLogin(provider);
    setOpenCodeAuthOutput(joinPresent("\n", result.message, result.output));
  }

  async function refreshOpenCodeAuthList(): Promise<void> {
    const result = await api.opencode.authList();
    setOpenCodeAuthOutput(joinPresent("\n", result.message, result.output));
  }

  async function runEngineeringPreflight(target: EngineeringProgramTarget = "all"): Promise<void> {
    if (engineeringPreflightBusy) {
      return;
    }
    setEngineeringPreflightBusy(true);
    const startedAt = new Date().toISOString();
    try {
      if (settingsDraft) {
        const saved = normalizeSettings(await api.settings.save(settingsToSave(settingsDraft)));
        setAppSettings(saved);
        setSettingsDraft(saved);
        setApiKeyInput("");
        setWebKeyInput("");
        setEmbeddingKeyInput("");
      }
      const result = await api.tools.preflightEngineering(target);
      setEngineeringPreflightResult(result);
      let diagnosticsReady = true;
      if (result.diagnostics) {
        setToolDiagnostics(result.diagnostics);
      } else {
        diagnosticsReady = await refreshToolDiagnostics();
      }
      if (diagnosticsReady) {
        setSettingsMessage("설정을 저장한 뒤 preflight를 실행했습니다.");
      }
    } catch (error) {
      const message = formatError(error);
      setEngineeringPreflightResult({
        target,
        status: "failed",
        error: message,
        startedAt,
        completedAt: new Date().toISOString()
      });
      setSettingsMessage(`Preflight 실패: ${message}`);
    } finally {
      setEngineeringPreflightBusy(false);
    }
  }

  async function runEngineeringWorkbench(): Promise<void> {
    setEngineeringRunBusy(true);
    setEngineeringRunMessage("");
    setEngineeringRunResult(undefined);
    const projectId = snapshot?.project.id;
    try {
      const result = await api.engineering.runProgram({
        projectId,
        title: "Clark Y XFOIL-WASM polar analysis",
        question: "Run a real Clark Y airfoil aerodynamic polar analysis and report the computed CL/CD values.",
        programRequests: [
          {
            kind: "xfoil-wasm-polar",
            target: "xfoil-wasm",
            sourceUrl: engineeringWorkbench.sourceUrl.trim(),
            reynolds: engineeringWorkbench.reynolds,
            mach: engineeringWorkbench.mach,
            alphaStart: engineeringWorkbench.alphaStart,
            alphaEnd: engineeringWorkbench.alphaEnd,
            alphaStep: engineeringWorkbench.alphaStep,
            reason: "Direct UI operation requested by the user."
          }
        ]
      });
      setEngineeringRunResult(result);
      if (projectId) {
        const latest = await api.snapshots.get(projectId);
        setSnapshot(latest);
        setEvents(latest.iterations.slice(-16));
      }
      const savedPath = result.savedReportArtifact?.relativePath;
      setEngineeringRunMessage(
        result.status === "completed"
          ? `Engineering program run completed${savedPath ? `; report saved to ${savedPath}` : "."}`
          : result.error ?? "Engineering program run failed."
      );
      void refreshToolDiagnostics();
    } catch (error) {
      setEngineeringRunMessage(formatError(error));
    } finally {
      setEngineeringRunBusy(false);
    }
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
    const diagnosticsReady = await refreshToolDiagnostics(undefined, "모델 설정이 저장되었습니다.");
    if (diagnosticsReady) {
      setSettingsMessage("모델 설정이 저장되었습니다.");
    }
  }

  function settingsToSave(draft: AppSettings): AppSettings {
    return {
      ...draft,
      openCodeLlm:
        draft.openCodeLlm.source === "api"
          ? {
              ...draft.openCodeLlm,
              apiKey: apiKeyInput.trim() || undefined
            }
          : draft.openCodeLlm,
      webSearch: {
        ...draft.webSearch,
        apiKey: webKeyInput.trim() || undefined
      },
      embedding: {
        ...draft.embedding,
        apiKey: embeddingKeyInput.trim() || undefined
      }
    };
  }

  async function refreshToolDiagnostics(disposed?: () => boolean, savedMessage?: string): Promise<boolean> {
    try {
      const diagnostics = await api.tools.diagnostics();
      if (!disposed?.()) {
        setToolDiagnostics(diagnostics);
      }
      return true;
    } catch (error) {
      if (!disposed?.()) {
        const prefix = savedMessage ? `${savedMessage} ` : "";
        setSettingsMessage(`${prefix}진단 갱신 실패: ${formatError(error)}`);
      }
      return false;
    }
  }

  const visibleChatSessions = useMemo(() => (snapshot ? chatSessionsFor(snapshot) : emptySessions), [snapshot]);

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
        visibleChatSessions={visibleChatSessions}
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
          settings={appSettings}
          toolDiagnostics={toolDiagnostics}
          stats={snapshotStats}
          events={events}
          metrics={metrics}
          busy={busy}
          engineeringWorkbench={engineeringWorkbench}
          engineeringRunResult={engineeringRunResult}
          engineeringRunBusy={engineeringRunBusy}
          engineeringRunMessage={engineeringRunMessage}
          onEngineeringWorkbenchChange={setEngineeringWorkbench}
          onRunEngineeringWorkbench={runEngineeringWorkbench}
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
          chatSessions={visibleChatSessions}
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
          toolDiagnostics={toolDiagnostics}
          apiKeyInput={apiKeyInput}
          webKeyInput={webKeyInput}
          embeddingKeyInput={embeddingKeyInput}
          openCodeAuthProvider={openCodeAuthProvider}
          openCodeAuthOutput={openCodeAuthOutput}
          engineeringPreflightResult={engineeringPreflightResult}
          engineeringPreflightBusy={engineeringPreflightBusy}
          onSave={saveSettings}
          onEngineeringPreflight={runEngineeringPreflight}
          onOpenCodeAuthProviderChange={setOpenCodeAuthProvider}
          onOpenCodeOAuthLogin={loginOpenCodeOAuth}
          onOpenCodeAuthList={refreshOpenCodeAuthList}
          onSettingsDraftChange={(next) => {
            setSettingsDraft(next);
            setSettingsMessage("");
            setEngineeringPreflightResult(undefined);
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
  visibleChatSessions,
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
  visibleChatSessions: ResearchSnapshot["sessions"];
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
                      {visibleChatSessions.map((session) => (
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

      <button
        className={`codexSettings ${activeTab === "settings" ? "active" : ""}`}
        type="button"
        onPointerDown={(event) => {
          if (event.button === 0) onTabChange("settings");
        }}
        onMouseDown={() => onTabChange("settings")}
        onTouchStart={() => onTabChange("settings")}
        onClick={() => onTabChange("settings")}
      >
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
  chatSessions,
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
  chatSessions: ResearchSnapshot["sessions"];
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
  const session = useMemo(
    () => (selectedSessionId ? chatSessions.find((item) => item.id === selectedSessionId) : undefined),
    [chatSessions, selectedSessionId]
  );
  const messages = useMemo(() => (session ? chatMessagesFor(snapshot, session.id, session.title) : []), [session, snapshot]);
  const renderedMessages = useMemo(() => chatMessageViews(messages), [messages]);
  const pendingForSession = session && pendingMessage?.sessionId === session.id ? pendingMessage : undefined;
  const pendingCreatedLabel = useMemo(
    () => (pendingForSession ? new Date(pendingForSession.createdAt).toLocaleString() : ""),
    [pendingForSession?.createdAt]
  );
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
          {renderedMessages.length ? (
            renderedMessages.map((message) => (
              <article key={message.id} className={`chatBubble ${message.role}`}>
                <p>{message.text}</p>
                <small>{message.createdLabel}</small>
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
                <small>{pendingCreatedLabel} · 전송 중</small>
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
  const models = provider === "codex-oauth" ? codexOAuthModels : modelOptions[provider];

  return (
    <div className="modelPickerPopover">
      <div className="modelPickerPanel">
        <p className="modelPickerTitle">연결</p>
        {homeModelProviderRows.map((row) => (
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
  settings,
  toolDiagnostics,
  stats,
  events,
  metrics,
  busy,
  engineeringWorkbench,
  engineeringRunResult,
  engineeringRunBusy,
  engineeringRunMessage,
  onEngineeringWorkbenchChange,
  onRunEngineeringWorkbench,
  onCreate,
  onStart
}: {
  input: ResearchProjectInput;
  setInput: (input: ResearchProjectInput) => void;
  snapshot: ResearchSnapshot;
  settings?: AppSettings;
  toolDiagnostics?: RuntimeToolDiagnostics;
  stats: SnapshotStats;
  events: LoopIteration[];
  metrics: Array<{ label: string; value: number }>;
  busy: boolean;
  engineeringWorkbench: EngineeringWorkbenchState;
  engineeringRunResult?: EngineeringProgramDirectRunResult;
  engineeringRunBusy: boolean;
  engineeringRunMessage: string;
  onEngineeringWorkbenchChange: (state: EngineeringWorkbenchState) => void;
  onRunEngineeringWorkbench: () => Promise<void>;
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
  const latestAudit = snapshot.runAuditOutputs.at(-1);
  const visitedSteps = useMemo(() => visitedStepSet(snapshot.iterations), [snapshot.iterations]);
  const memoryItems = useMemo(() => memoryRows(stats), [stats]);
  const researchQuestionPreview = useMemo(() => joinFirstStrings(latestSpec?.researchQuestions ?? [], 3, " / "), [latestSpec]);
  const blockerMessages = useMemo(() => recentBlockerMessages(snapshot), [snapshot]);
  const recentToolRuns = useMemo(() => lastItems(snapshot.toolRuns, 4), [snapshot.toolRuns]);
  const researchToolReadiness = useMemo(() => buildRuntimeResearchToolReadiness(settings, snapshot, toolDiagnostics), [settings, snapshot, toolDiagnostics]);
  const recentResearchProgramRuns = useMemo(() => recentIntegratedToolRuns(snapshot.toolRuns), [snapshot.toolRuns]);
  const appExternalAccess = Boolean(settings?.allowExternalSearch);
  const appCodeExecution = Boolean(settings?.allowCodeExecution);
  const activeRunLogs = activeRun?.logs ?? emptyRunLogs;
  const stepTileGroups = useMemo(() => {
    const renderStepTile = (step: ResearchLoopStep): ReactElement => {
      const meta = stepLabels[step];
      const Icon = meta.icon;
      const active = currentStep === step;
      const visited = visitedSteps.has(step);
      return (
        <div key={step} className={`stepTile ${meta.flow} ${active ? "active" : ""} ${visited ? "visited" : ""}`}>
          <div className="stepIndex">{meta.index}</div>
          <Icon size={21} />
          <span>{meta.label}</span>
        </div>
      );
    };
    return {
      design: designSteps.map(renderStepTile),
      loop: loopSteps.map(renderStepTile),
      decision: decisionSteps.map(renderStepTile)
    };
  }, [currentStep, visitedSteps]);

  return (
    <section className="codexContent">
      <header className="codexTopbar">
        <div>
          <p className="eyebrow">Main Flow / Data Flow / Agent Control / Knowledge Flow / Error Flow</p>
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
          <label className="loopLimitControl">
            최대 반복
            <input
              aria-label="Maximum loop iterations"
              type="number"
              min={1}
              max={maxGuiLoopLimit}
              step={1}
              value={input.autonomyPolicy.maxLoopIterations ?? defaultGuiLoopLimit}
              onChange={(event) =>
                setInput({
                  ...input,
                  autonomyPolicy: {
                    ...input.autonomyPolicy,
                    maxLoopIterations: normalizeLoopLimit(event.target.value)
                  }
                })
              }
            />
          </label>
          <label className={`policyToggle ${appExternalAccess ? "ready" : "blocked"}`}>
            <input
              type="checkbox"
              checked={input.autonomyPolicy.allowExternalSearch}
              onChange={(event) =>
                setInput({
                  ...input,
                  autonomyPolicy: { ...input.autonomyPolicy, allowExternalSearch: event.target.checked }
                })
              }
            />
            <span>
              <strong>외부 자료 접근</strong>
              <small>{appExternalAccess ? "OpenAlex, Browser, Fetch 허용" : "앱 설정에서 외부 접근 꺼짐"}</small>
            </span>
          </label>
          <label className={`policyToggle ${appCodeExecution ? "ready" : "blocked"}`}>
            <input
              type="checkbox"
              checked={input.autonomyPolicy.allowCodeExecution}
              onChange={(event) =>
                setInput({
                  ...input,
                  autonomyPolicy: { ...input.autonomyPolicy, allowCodeExecution: event.target.checked }
                })
              }
            />
            <span>
              <strong>코드/프로그램 실행</strong>
              <small>{appCodeExecution ? "CodeExecution, engineering tools 허용" : "앱 설정에서 코드 실행 꺼짐"}</small>
            </span>
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
          <div className="flowGroupGrid">{stepTileGroups.design}</div>
        </div>
        <div className="flowGroup loop">
          <div className="flowGroupHeader">
            <h2>연구 실행 및 분석 반복 루프</h2>
            <span>11에서 계속이면 4번 연구 계획 수립으로 복귀</span>
          </div>
          <div className="flowGroupGrid loopGrid">{stepTileGroups.loop}</div>
        </div>
        <div className="flowGroup decision">
          <h2>루프 판단 및 최종 산출</h2>
          <div className="flowGroupGrid decisionGrid">{stepTileGroups.decision}</div>
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
            <p>{researchQuestionPreview ?? "아직 연구 명세가 없습니다."}</p>
          </div>
          <div className="latestResult">
            <h3>현재 연구 계획</h3>
            <p>{latestPlan ? latestPlan.objective : "아직 연구 계획이 없습니다."}</p>
          </div>
        </section>

        <section className="panel wide">
          <div className="panelTitle">
            <FlaskConical size={17} />
            <h2>연구 메타데이터 / 프로그램 도구</h2>
          </div>
          <div className="toolReadinessGrid">
            {researchToolReadiness.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.id} className={`toolReadinessItem ${item.status}`}>
                  <div className="toolReadinessHeader">
                    <Icon size={18} />
                    <strong>{item.label}</strong>
                    <span>{item.badge}</span>
                  </div>
                  <p>{item.detail}</p>
                </article>
              );
            })}
          </div>
          <div className="toolRunStrip">
            {recentResearchProgramRuns.length ? (
              recentResearchProgramRuns.map((toolRun) => (
                <span key={toolRun.id} className={toolRun.status}>
                  {toolRun.toolName}: {toolRun.status}
                </span>
              ))
            ) : (
              <span className="skipped">ResearchMetadataTool / EngineeringProgramTool 실행 기록 없음</span>
            )}
          </div>
        </section>

        <EngineeringProgramWorkbench
          state={engineeringWorkbench}
          result={engineeringRunResult}
          busy={engineeringRunBusy}
          message={engineeringRunMessage}
          codeReady={appCodeExecution}
          xfoilWasmReady={Boolean(
            appCodeExecution &&
              toolDiagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-wasm-polar:xfoil-wasm")?.ready
          )}
          onChange={onEngineeringWorkbenchChange}
          onRun={onRunEngineeringWorkbench}
        />

        <section className="panel">
          <div className="panelTitle">
            <AlertTriangle size={17} />
            <h2>오류 / Blocker</h2>
          </div>
          <div className="runBox">
            {snapshot.runtimeBlockers.length || snapshot.stepErrors.length ? (
              blockerMessages.map((message, index) => (
                <p key={`${index}-${message}`}>{message}</p>
              ))
            ) : (
              <p>현재 runtime blocker나 step error가 없습니다.</p>
            )}
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
          <StorageList stats={stats} />
        </section>

        <section className="panel">
          <div className="panelTitle">
            <Bot size={17} />
            <h2>OpenCode / Tool 로그</h2>
          </div>
          <div className="runBox">
            <h3>{activeRun?.toolPlan.join(" / ") || "대기"}</h3>
            {activeRunLogs.map((log) => (
              <p key={log}>{log}</p>
            ))}
            {recentToolRuns.map((toolRun) => (
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
            {snapshot.project.status === "failed" && latestAudit ? (
              <>
                <FinalItem title="Run audit" value={latestAudit.markdownReport} />
                <FinalItem title="Failure reason" value={latestAudit.failureReason} />
                <FinalItem title="Completed iterations" value={String(latestAudit.completedIterations)} />
              </>
            ) : (
              <>
                <FinalItem title="Answer" value={snapshot.report?.answer} />
                <FinalItem title="Hypothesis verification" value={snapshot.report?.hypothesisVerification} />
                <FinalItem title="Quantitative / qualitative" value={snapshot.report?.quantitativeQualitativeResults} />
              </>
            )}
            <FinalItem title="Continuation decision" value={latestDecision ? (latestDecision.shouldContinue ? "Continue - " : "Finalize - ") + latestDecision.reason : undefined} />
            <FinalItem title="Comprehensive report" value={snapshot.report?.comprehensiveReport} />
            <FinalItem title="Reusable knowledge" value={snapshot.report?.reusableKnowledgeAsset} />
          </div>
        </section>
      </div>
    </section>
  );
}

function EngineeringProgramWorkbench({
  state,
  result,
  busy,
  message,
  codeReady,
  xfoilWasmReady,
  onChange,
  onRun
}: {
  state: EngineeringWorkbenchState;
  result?: EngineeringProgramDirectRunResult;
  busy: boolean;
  message: string;
  codeReady: boolean;
  xfoilWasmReady: boolean;
  onChange: (state: EngineeringWorkbenchState) => void;
  onRun: () => Promise<void>;
}): ReactElement {
  const summary = useMemo(() => engineeringRunSummary(result), [result]);
  const rows = summary.rows;
  const canRun = codeReady && xfoilWasmReady && Boolean(state.sourceUrl.trim()) && !busy;
  return (
    <section className="panel wide engineeringWorkbenchPanel">
      <div className="panelTitle">
        <Wrench size={17} />
        <h2>Engineering Program Workbench</h2>
      </div>
      <div className="engineeringWorkbenchGrid">
        <div className="engineeringWorkbenchControls">
          <label>
            Airfoil coordinate source URL
            <input value={state.sourceUrl} onChange={(event) => onChange({ ...state, sourceUrl: event.target.value })} />
          </label>
          <div className="fieldGrid three">
            <label>
              Reynolds
              <input
                type="number"
                min={1_000}
                max={100_000_000}
                step={10_000}
                value={state.reynolds}
                onChange={(event) => onChange({ ...state, reynolds: parseNumericInput(event.target.value, state.reynolds) })}
              />
            </label>
            <label>
              Mach
              <input
                type="number"
                min={0}
                max={0.8}
                step={0.01}
                value={state.mach}
                onChange={(event) => onChange({ ...state, mach: parseNumericInput(event.target.value, state.mach) })}
              />
            </label>
            <label>
              Alpha step
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={state.alphaStep}
                onChange={(event) => onChange({ ...state, alphaStep: parseNumericInput(event.target.value, state.alphaStep) })}
              />
            </label>
          </div>
          <div className="fieldGrid three">
            <label>
              Alpha start
              <input
                type="number"
                min={-30}
                max={30}
                step={0.5}
                value={state.alphaStart}
                onChange={(event) => onChange({ ...state, alphaStart: parseNumericInput(event.target.value, state.alphaStart) })}
              />
            </label>
            <label>
              Alpha end
              <input
                type="number"
                min={-30}
                max={30}
                step={0.5}
                value={state.alphaEnd}
                onChange={(event) => onChange({ ...state, alphaEnd: parseNumericInput(event.target.value, state.alphaEnd) })}
              />
            </label>
            <button className="primaryButton engineeringRunButton" type="button" onClick={() => void onRun()} disabled={!canRun}>
              {busy ? <Loader2 className="spin" size={17} /> : <FlaskConical size={17} />}
              Run XFOIL-WASM
            </button>
          </div>
          <div className="engineeringStatusGrid">
            <span className={codeReady ? "ready" : "blocked"}>Code execution {codeReady ? "ready" : "blocked"}</span>
            <span className={xfoilWasmReady ? "ready" : "blocked"}>XFOIL-WASM {xfoilWasmReady ? "ready" : "blocked"}</span>
            {message ? <span className={result?.status === "completed" ? "ready" : "blocked"}>{message}</span> : null}
          </div>
        </div>
        <div className="engineeringWorkbenchResult">
          <div className="engineeringResultHeader">
            <strong>{summary.airfoil || "No run yet"}</strong>
            <span>{result ? `${result.status} / artifacts ${result.artifacts.length} / evidence ${result.evidence.length}` : "ready for direct operation"}</span>
          </div>
          {result?.savedReportArtifact ? <p className="engineeringSavedReport">Saved report: {result.savedReportArtifact.relativePath}</p> : null}
          {summary.runtime ? (
            <p className="engineeringResultMeta">
              {summary.runtime} {summary.runtimeVersion} / {summary.runtimeLicense} / rows {summary.rowCount ?? rows.length}
            </p>
          ) : null}
          {rows.length ? (
            <div className="engineeringTableWrap">
              <table className="engineeringResultTable">
                <thead>
                  <tr>
                    <th>alpha</th>
                    <th>CL</th>
                    <th>CD</th>
                    <th>Cm</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.alpha}-${row.cl}-${row.cd}`}>
                      <td>{formatEngineeringNumber(row.alpha)}</td>
                      <td>{formatEngineeringNumber(row.cl)}</td>
                      <td>{formatEngineeringNumber(row.cd)}</td>
                      <td>{formatEngineeringNumber(row.cm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="engineeringEmpty">Run the bundled XFOIL-WASM solver to generate a real polar table.</p>
          )}
        </div>
      </div>
      {result?.reportMarkdown ? <pre className="engineeringReport">{result.reportMarkdown}</pre> : null}
    </section>
  );
}

function CodexPlaceholder({ activeTab }: { activeTab: SidebarTab }): ReactElement {
  return (
    <section className="codexPlaceholder">
      <div className="placeholderCard">
        <h1>{sidebarTabLabels[activeTab]}</h1>
        <p>이 영역은 이후 AetherOps 프로젝트 자료와 연결될 예정입니다. 연구 프로젝트는 왼쪽 사이드바 또는 첫 화면에서 생성할 수 있습니다.</p>
      </div>
    </section>
  );
}

function SettingsTab({
  appSettings,
  settingsDraft,
  settingsMessage,
  toolDiagnostics,
  apiKeyInput,
  webKeyInput,
  embeddingKeyInput,
  openCodeAuthProvider,
  openCodeAuthOutput,
  engineeringPreflightResult,
  engineeringPreflightBusy,
  onSave,
  onEngineeringPreflight,
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
  toolDiagnostics?: RuntimeToolDiagnostics;
  apiKeyInput: string;
  webKeyInput: string;
  embeddingKeyInput: string;
  openCodeAuthProvider: string;
  openCodeAuthOutput: string;
  engineeringPreflightResult?: EngineeringProgramPreflightResult;
  engineeringPreflightBusy: boolean;
  onSave: () => Promise<void>;
  onEngineeringPreflight: (target?: EngineeringProgramTarget) => Promise<void>;
  onOpenCodeAuthProviderChange: (provider: string) => void;
  onOpenCodeOAuthLogin: () => Promise<void>;
  onOpenCodeAuthList: () => Promise<void>;
  onSettingsDraftChange: (settings: AppSettings) => void;
  onApiKeyInputChange: (value: string) => void;
  onWebKeyInputChange: (value: string) => void;
  onEmbeddingKeyInputChange: (value: string) => void;
}): ReactElement {
  const engineeringArtifactCandidates = toolDiagnostics?.engineeringArtifactCandidates ?? [];
  const readyEngineeringArtifactCandidates = engineeringArtifactCandidates.filter((candidate) => candidate.ready).length;
  const showEngineeringArtifactCandidates = Boolean(settingsDraft.engineeringTools.modeling.artifactRoot?.trim() || engineeringArtifactCandidates.length);
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
                  options={openCodeLlmBaseUrlOptions}
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
              options={webSearchEndpointOptions}
              onChange={(endpoint) => onSettingsDraftChange({ ...settingsDraft, webSearch: { ...settingsDraft.webSearch, endpoint } })}
            />
          </label>
        </section>

        <section className="settingsGroup">
          <div className="panelTitle">
            <FlaskConical size={17} />
            <h3>Research metadata</h3>
          </div>
          <div className="fieldGrid">
            <label>
              OpenAlex
              <select
                value={settingsDraft.researchMetadata.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    researchMetadata: { ...settingsDraft.researchMetadata, enabled: event.target.value === "true" }
                  })
                }
              >
                <option value="true">enabled</option>
                <option value="false">disabled</option>
              </select>
            </label>
            <label>
              Max results
              <NumberSelect
                value={settingsDraft.researchMetadata.maxResults}
                options={researchMetadataMaxResultOptions}
                onChange={(maxResults) =>
                  onSettingsDraftChange({ ...settingsDraft, researchMetadata: { ...settingsDraft.researchMetadata, maxResults } })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              Timeout(ms)
              <NumberSelect
                value={settingsDraft.researchMetadata.timeoutMs}
                options={researchMetadataTimeoutOptions}
                onChange={(timeoutMs) =>
                  onSettingsDraftChange({ ...settingsDraft, researchMetadata: { ...settingsDraft.researchMetadata, timeoutMs } })
                }
              />
            </label>
            <label>
              Mailto
              <StringSelect
                value={settingsDraft.researchMetadata.mailto ?? ""}
                options={[""]}
                onChange={(mailto) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    researchMetadata: { ...settingsDraft.researchMetadata, mailto: mailto || undefined }
                  })
                }
              />
            </label>
          </div>
        </section>

        <section className="settingsGroup settingsGroupWide">
          <div className="panelTitle">
            <Wrench size={17} />
            <h3>Engineering programs</h3>
          </div>
          <div className="preflightPanel">
            <button
              type="button"
              className="primaryButton iconButtonText"
              disabled={engineeringPreflightBusy}
              onClick={() => void onEngineeringPreflight("all")}
            >
              {engineeringPreflightBusy ? <Loader2 size={16} className="spin" /> : <Gauge size={16} />}
              <span>Save & run preflight</span>
            </button>
            <div className={`preflightResult ${engineeringPreflightResult?.status ?? "idle"}`}>
              <strong>{engineeringPreflightStatusLabel(engineeringPreflightResult, engineeringPreflightBusy)}</strong>
              <span>{engineeringPreflightSummary(engineeringPreflightResult)}</span>
            </div>
          </div>
          {engineeringPreflightResult?.output ? (
            <pre className="preflightOutput">{engineeringPreflightOutput(engineeringPreflightResult.output)}</pre>
          ) : null}
          {showEngineeringArtifactCandidates ? (
            <div className="artifactCandidateList">
              <div className="requestContractHeader">
                <strong>Modeling artifact candidates</strong>
                <span>
                  {readyEngineeringArtifactCandidates}/{engineeringArtifactCandidates.length} usable
                </span>
              </div>
              {engineeringArtifactCandidates.length ? (
                engineeringArtifactCandidates.slice(0, 8).map((candidate) => (
                  <div key={candidate.relativePath} className={`artifactCandidateItem ${candidate.ready ? "ready" : "blocked"}`}>
                    <span>{candidate.relativePath}</span>
                    <strong>
                      {candidate.ready
                        ? `${candidate.format.toUpperCase()} ${formatByteSize(candidate.byteLength)}`
                        : (candidate.blockedReason ?? "blocked")}
                    </strong>
                  </div>
                ))
              ) : (
                <p className="artifactCandidateEmpty">No OBJ/STL or airfoil coordinate files are visible under the configured modeling artifact root.</p>
              )}
              {engineeringArtifactCandidates.length > 8 ? (
                <p className="artifactCandidateEmpty">+{engineeringArtifactCandidates.length - 8} more candidate files are hidden from this view.</p>
              ) : null}
            </div>
          ) : null}
          {toolDiagnostics?.engineeringProgramRequestTemplates.length ? (
            <div className="requestContractList">
              <div className="requestContractHeader">
                <strong>LLM request contract</strong>
                <span>{toolDiagnostics.engineeringProgramRequestTemplates.filter((template) => template.ready).length} ready</span>
              </div>
              {toolDiagnostics.engineeringProgramRequestTemplates.map((template) => (
                <details key={template.id} className={`requestContractItem ${template.ready ? "ready" : "blocked"}`}>
                  <summary>
                    <span>{template.label}</span>
                    <small>{template.ready ? template.description : template.blockedReason ?? template.description}</small>
                    <strong>{template.ready ? "ready" : "blocked"}</strong>
                  </summary>
                  <p>{template.ready ? template.description : template.blockedReason ?? template.description}</p>
                  <code>{engineeringRequestTemplatePreview(template.request)}</code>
                </details>
              ))}
            </div>
          ) : null}
          <div className="fieldGrid three">
            <label>
              Program tools
              <select
                value={settingsDraft.engineeringTools.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: { ...settingsDraft.engineeringTools, enabled: event.target.value === "true" }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              XFOIL
              <select
                value={settingsDraft.engineeringTools.xfoil.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      xfoil: { ...settingsDraft.engineeringTools.xfoil, enabled: event.target.value === "true" }
                    }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              XFOIL timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.xfoil.timeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(timeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      xfoil: { ...settingsDraft.engineeringTools.xfoil, timeoutMs }
                    }
                  })
                }
              />
            </label>
          </div>
          <label>
            XFOIL command
            <input
              value={settingsDraft.engineeringTools.xfoil.command ?? ""}
              list="xfoil-command-options"
              onChange={(event) =>
                onSettingsDraftChange({
                  ...settingsDraft,
                  engineeringTools: {
                    ...settingsDraft.engineeringTools,
                    xfoil: { ...settingsDraft.engineeringTools.xfoil, command: event.target.value }
                  }
                })
              }
            />
            <datalist id="xfoil-command-options">
              {xfoilCommandOptions.map((option) => (
                <option key={option || "empty"} value={option} />
              ))}
            </datalist>
          </label>
          <div className="fieldGrid">
            <label>
              Modeling artifacts
              <select
                value={settingsDraft.engineeringTools.modeling.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      modeling: { ...settingsDraft.engineeringTools.modeling, enabled: event.target.value === "true" }
                    }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              Mesh byte limit
              <NumberSelect
                value={settingsDraft.engineeringTools.modeling.maxMeshBytes}
                options={meshByteLimitOptions}
                onChange={(maxMeshBytes) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      modeling: { ...settingsDraft.engineeringTools.modeling, maxMeshBytes }
                    }
                  })
                }
              />
            </label>
          </div>
          <label>
            Modeling artifact root
            <input
              value={settingsDraft.engineeringTools.modeling.artifactRoot ?? ""}
              onChange={(event) =>
                onSettingsDraftChange({
                  ...settingsDraft,
                  engineeringTools: {
                    ...settingsDraft.engineeringTools,
                    modeling: { ...settingsDraft.engineeringTools.modeling, artifactRoot: event.target.value }
                  }
                })
              }
            />
          </label>
          <div className="fieldGrid">
            <label>
              OpenFOAM
              <select
                value={settingsDraft.engineeringTools.openFoam.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openFoam: { ...settingsDraft.engineeringTools.openFoam, enabled: event.target.value === "true" }
                    }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              OpenFOAM timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.openFoam.timeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(timeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openFoam: { ...settingsDraft.engineeringTools.openFoam, timeoutMs }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              OpenFOAM command
              <input
                value={settingsDraft.engineeringTools.openFoam.command ?? ""}
                list="openfoam-command-options"
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openFoam: { ...settingsDraft.engineeringTools.openFoam, command: event.target.value }
                    }
                  })
                }
              />
              <datalist id="openfoam-command-options">
                {openFoamCommandOptions.map((option) => (
                  <option key={option || "empty"} value={option} />
                ))}
              </datalist>
            </label>
            <label>
              OpenFOAM case root
              <input
                value={settingsDraft.engineeringTools.openFoam.caseRoot ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openFoam: { ...settingsDraft.engineeringTools.openFoam, caseRoot: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <label>
            OpenFOAM workdir
            <input
              value={settingsDraft.engineeringTools.openFoam.workingDirectory ?? ""}
              onChange={(event) =>
                onSettingsDraftChange({
                  ...settingsDraft,
                  engineeringTools: {
                    ...settingsDraft.engineeringTools,
                    openFoam: { ...settingsDraft.engineeringTools.openFoam, workingDirectory: event.target.value }
                  }
                })
              }
            />
          </label>
          <div className="fieldGrid">
            <label>
              OpenFOAM args template
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.openFoam.runArgsTemplate)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openFoam: { ...settingsDraft.engineeringTools.openFoam, runArgsTemplate: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
            <label>
              OpenFOAM probe args
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.openFoam.probeArgs)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openFoam: { ...settingsDraft.engineeringTools.openFoam, probeArgs: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              SU2
              <select
                value={settingsDraft.engineeringTools.su2.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, enabled: event.target.value === "true" }
                    }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              SU2 timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.su2.timeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(timeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, timeoutMs }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              SU2 command
              <input
                value={settingsDraft.engineeringTools.su2.command ?? ""}
                list="su2-command-options"
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, command: event.target.value }
                    }
                  })
                }
              />
              <datalist id="su2-command-options">
                {su2CommandOptions.map((option) => (
                  <option key={option || "empty"} value={option} />
                ))}
              </datalist>
            </label>
            <label>
              SU2 case root
              <input
                value={settingsDraft.engineeringTools.su2.caseRoot ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, caseRoot: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              SU2 config file
              <input
                value={settingsDraft.engineeringTools.su2.configFile ?? ""}
                placeholder="case.cfg"
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, configFile: event.target.value }
                    }
                  })
                }
              />
            </label>
            <label>
              SU2 workdir
              <input
                value={settingsDraft.engineeringTools.su2.workingDirectory ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, workingDirectory: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              SU2 args template
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.su2.runArgsTemplate)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, runArgsTemplate: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
            <label>
              SU2 probe args
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.su2.probeArgs)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      su2: { ...settingsDraft.engineeringTools.su2, probeArgs: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FreeCAD
              <select
                value={settingsDraft.engineeringTools.freeCad.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      freeCad: { ...settingsDraft.engineeringTools.freeCad, enabled: event.target.value === "true" }
                    }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              FreeCAD timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.freeCad.timeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(timeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      freeCad: { ...settingsDraft.engineeringTools.freeCad, timeoutMs }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FreeCAD command
              <input
                value={settingsDraft.engineeringTools.freeCad.command ?? ""}
                list="freecad-command-options"
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      freeCad: { ...settingsDraft.engineeringTools.freeCad, command: event.target.value }
                    }
                  })
                }
              />
              <datalist id="freecad-command-options">
                {freeCadCommandOptions.map((option) => (
                  <option key={option || "empty"} value={option} />
                ))}
              </datalist>
            </label>
            <label>
              FreeCAD script path
              <input
                value={settingsDraft.engineeringTools.freeCad.scriptPath ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      freeCad: { ...settingsDraft.engineeringTools.freeCad, scriptPath: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <label>
            FreeCAD workdir
            <input
              value={settingsDraft.engineeringTools.freeCad.workingDirectory ?? ""}
              onChange={(event) =>
                onSettingsDraftChange({
                  ...settingsDraft,
                  engineeringTools: {
                    ...settingsDraft.engineeringTools,
                    freeCad: { ...settingsDraft.engineeringTools.freeCad, workingDirectory: event.target.value }
                  }
                })
              }
            />
          </label>
          <div className="fieldGrid">
            <label>
              FreeCAD args template
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.freeCad.runArgsTemplate)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      freeCad: { ...settingsDraft.engineeringTools.freeCad, runArgsTemplate: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
            <label>
              FreeCAD probe args
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.freeCad.probeArgs)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      freeCad: { ...settingsDraft.engineeringTools.freeCad, probeArgs: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              OpenVSP
              <select
                value={settingsDraft.engineeringTools.openVsp.enabled ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openVsp: { ...settingsDraft.engineeringTools.openVsp, enabled: event.target.value === "true" }
                    }
                  })
                }
              >
                <option value="false">disabled</option>
                <option value="true">enabled</option>
              </select>
            </label>
            <label>
              OpenVSP timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.openVsp.timeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(timeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openVsp: { ...settingsDraft.engineeringTools.openVsp, timeoutMs }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              OpenVSP command
              <input
                value={settingsDraft.engineeringTools.openVsp.command ?? ""}
                list="openvsp-command-options"
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openVsp: { ...settingsDraft.engineeringTools.openVsp, command: event.target.value }
                    }
                  })
                }
              />
              <datalist id="openvsp-command-options">
                {openVspCommandOptions.map((option) => (
                  <option key={option || "empty"} value={option} />
                ))}
              </datalist>
            </label>
            <label>
              OpenVSP script path
              <input
                value={settingsDraft.engineeringTools.openVsp.scriptPath ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openVsp: { ...settingsDraft.engineeringTools.openVsp, scriptPath: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <label>
            OpenVSP workdir
            <input
              value={settingsDraft.engineeringTools.openVsp.workingDirectory ?? ""}
              onChange={(event) =>
                onSettingsDraftChange({
                  ...settingsDraft,
                  engineeringTools: {
                    ...settingsDraft.engineeringTools,
                    openVsp: { ...settingsDraft.engineeringTools.openVsp, workingDirectory: event.target.value }
                  }
                })
              }
            />
          </label>
          <div className="fieldGrid">
            <label>
              OpenVSP args template
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.openVsp.runArgsTemplate)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openVsp: { ...settingsDraft.engineeringTools.openVsp, runArgsTemplate: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
            <label>
              OpenVSP probe args
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.openVsp.probeArgs)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      openVsp: { ...settingsDraft.engineeringTools.openVsp, probeArgs: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FlightStream
              <select
                value={settingsDraft.engineeringTools.commercialCfd.flightStreamConfigured ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: {
                        ...settingsDraft.engineeringTools.commercialCfd,
                        flightStreamConfigured: event.target.value === "true"
                      }
                    }
                  })
                }
              >
                <option value="false">not configured</option>
                <option value="true">licensed externally</option>
              </select>
            </label>
            <label>
              STAR-CCM+
              <select
                value={settingsDraft.engineeringTools.commercialCfd.starCcmConfigured ? "true" : "false"}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: {
                        ...settingsDraft.engineeringTools.commercialCfd,
                        starCcmConfigured: event.target.value === "true"
                      }
                    }
                  })
                }
              >
                <option value="false">not configured</option>
                <option value="true">licensed externally</option>
              </select>
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FlightStream command
              <input
                value={settingsDraft.engineeringTools.commercialCfd.flightStreamCommand ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, flightStreamCommand: event.target.value }
                    }
                  })
                }
              />
            </label>
            <label>
              STAR-CCM+ command
              <input
                value={settingsDraft.engineeringTools.commercialCfd.starCcmCommand ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, starCcmCommand: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FlightStream workdir
              <input
                value={settingsDraft.engineeringTools.commercialCfd.flightStreamWorkingDirectory ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, flightStreamWorkingDirectory: event.target.value }
                    }
                  })
                }
              />
            </label>
            <label>
              STAR-CCM+ workdir
              <input
                value={settingsDraft.engineeringTools.commercialCfd.starCcmWorkingDirectory ?? ""}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, starCcmWorkingDirectory: event.target.value }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FlightStream timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.commercialCfd.flightStreamTimeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(flightStreamTimeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, flightStreamTimeoutMs }
                    }
                  })
                }
              />
            </label>
            <label>
              STAR-CCM+ timeout(ms)
              <NumberSelect
                value={settingsDraft.engineeringTools.commercialCfd.starCcmTimeoutMs}
                options={engineeringTimeoutOptions}
                onChange={(starCcmTimeoutMs) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, starCcmTimeoutMs }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FlightStream args template
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.commercialCfd.flightStreamRunArgsTemplate)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, flightStreamRunArgsTemplate: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
            <label>
              STAR-CCM+ args template
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.commercialCfd.starCcmRunArgsTemplate)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, starCcmRunArgsTemplate: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
          </div>
          <div className="fieldGrid">
            <label>
              FlightStream probe args
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.commercialCfd.flightStreamProbeArgs)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, flightStreamProbeArgs: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
            <label>
              STAR-CCM+ probe args
              <textarea
                value={joinArgTemplate(settingsDraft.engineeringTools.commercialCfd.starCcmProbeArgs)}
                onChange={(event) =>
                  onSettingsDraftChange({
                    ...settingsDraft,
                    engineeringTools: {
                      ...settingsDraft.engineeringTools,
                      commercialCfd: { ...settingsDraft.engineeringTools.commercialCfd, starCcmProbeArgs: splitArgTemplate(event.target.value) }
                    }
                  })
                }
              />
            </label>
          </div>
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
                value={settingsDraft.embedding.provider === "local" ? "openai" : settingsDraft.embedding.provider}
                onChange={(event) => {
                  const provider = event.target.value as AppSettings["embedding"]["provider"];
                  onSettingsDraftChange({
                    ...settingsDraft,
                    embedding: { ...settingsDraft.embedding, provider, model: embeddingModelOptions[provider][0] }
                  });
                }}
              >
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
              placeholder={settingsDraft.embedding.apiKeyConfigured ? "이미 저장됨. 새 값만 입력" : "임베딩 API key 필요"}
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

interface EngineeringRunSummaryView {
  airfoil?: string;
  runtime?: string;
  runtimeVersion?: string;
  runtimeLicense?: string;
  rowCount?: number;
  rows: Array<{ alpha?: number; cl?: number; cd?: number; cm?: number }>;
}

function engineeringRunSummary(result: EngineeringProgramDirectRunResult | undefined): EngineeringRunSummaryView {
  if (!result) return { rows: [] };
  for (const run of result.programRuns) {
    const summary = asPlainRecord(asPlainRecord(run)?.summary);
    const rows = Array.isArray(summary?.rows) ? summary.rows.map(engineeringPolarRow).filter((row) => row.alpha !== undefined) : [];
    if (summary) {
      return {
        airfoil: optionalText(summary.airfoil),
        runtime: optionalText(summary.runtime),
        runtimeVersion: optionalText(summary.runtimeVersion),
        runtimeLicense: optionalText(summary.runtimeLicense),
        rowCount: optionalNumber(summary.rowCount),
        rows
      };
    }
  }
  return { rows: [] };
}

function engineeringPolarRow(value: unknown): { alpha?: number; cl?: number; cd?: number; cm?: number } {
  const row = asPlainRecord(value);
  return {
    alpha: optionalNumber(row?.alpha),
    cl: optionalNumber(row?.cl),
    cd: optionalNumber(row?.cd),
    cm: optionalNumber(row?.cm)
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const next = typeof value === "number" ? value : Number(value);
  return Number.isFinite(next) ? next : undefined;
}

function parseNumericInput(value: string, previous: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : previous;
}

function formatEngineeringNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return Number(value.toFixed(5)).toString();
}

function StringSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }): ReactElement {
  const normalizedOptions = useMemo(() => normalizedStringOptions(value, options), [value, options]);
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
  const normalizedOptions = useMemo(() => normalizedNumberOptions(value, options), [value, options]);
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

function normalizedStringOptions(value: string, options: string[]): string[] {
  if (!value || includesString(options, value)) return options;
  const normalized = [value];
  for (const option of options) normalized.push(option);
  return normalized;
}

function normalizedNumberOptions(value: number, options: number[]): number[] {
  if (includesNumber(options, value)) return options;
  const normalized = [value];
  for (const option of options) normalized.push(option);
  normalized.sort((left, right) => left - right);
  return normalized;
}

function includesString(values: string[], target: string): boolean {
  for (const value of values) {
    if (value === target) return true;
  }
  return false;
}

function includesNumber(values: number[], target: number): boolean {
  for (const value of values) {
    if (value === target) return true;
  }
  return false;
}

function splitArgTemplate(value: string): string[] {
  const args: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const cleaned = line.trim();
    if (cleaned) args.push(cleaned);
    if (args.length >= 24) break;
  }
  return args;
}

function joinArgTemplate(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

function engineeringPreflightStatusLabel(result: EngineeringProgramPreflightResult | undefined, busy: boolean): string {
  if (busy) return "Running";
  if (!result) return "Not run";
  return result.status === "completed" ? "Completed" : "Failed";
}

function engineeringPreflightSummary(result: EngineeringProgramPreflightResult | undefined): string {
  if (!result) return "Saved settings only";
  if (result.status === "failed") return result.error ?? "Preflight failed";
  const output = result.output as { checked?: unknown; unavailable?: unknown } | undefined;
  const checked = Array.isArray(output?.checked) ? output.checked.map(String).join(", ") : result.target;
  const unavailable = Array.isArray(output?.unavailable) && output.unavailable.length ? `; unavailable ${output.unavailable.length}` : "";
  return `checked ${checked || result.target}${unavailable}`;
}

function engineeringPreflightOutput(output: unknown): string {
  const text = JSON.stringify(output, null, 2);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n...` : text;
}

function engineeringRequestTemplatePreview(request: unknown): string {
  const text = JSON.stringify(request);
  return text.length > 360 ? `${text.slice(0, 360)}...` : text;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ToolReadinessStatus = "ready" | "blocked" | "idle";

interface ToolReadinessItem {
  id: string;
  label: string;
  badge: string;
  detail: string;
  status: ToolReadinessStatus;
  icon: IconComponent;
}

function buildResearchToolReadiness(
  settings: AppSettings | undefined,
  snapshot: ResearchSnapshot,
  diagnostics?: RuntimeToolDiagnostics
): ToolReadinessItem[] {
  const externalAllowed = Boolean(settings?.allowExternalSearch && snapshot.project.autonomyPolicy.allowExternalSearch);
  const codeAllowed = Boolean(settings?.allowCodeExecution && snapshot.project.autonomyPolicy.allowCodeExecution);
  const metadataReady = Boolean(externalAllowed && (diagnostics ? diagnostics.researchMetadata.ready : settings?.researchMetadata.enabled));
  const xfoilCapability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "xfoil-polar");
  const xfoilWasmCapability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "xfoil-wasm-polar");
  const modelingCapability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "mesh-inspect");
  const openFoamCapability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "openfoam-case-run");
  const su2Capability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "su2-case-run");
  const freeCadCapability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "cad-script-run");
  const openVspCapability = diagnostics?.engineeringPrograms.find((capability) => capability.kind === "vsp-script-run");
  const flightStreamCapability = diagnostics?.engineeringPrograms.find((capability) => capability.target === "flightstream");
  const starCcmCapability = diagnostics?.engineeringPrograms.find((capability) => capability.target === "starccm");
  const xfoilConfigured = diagnostics ? Boolean(codeAllowed && xfoilCapability?.ready) : Boolean(settings?.engineeringTools.xfoil.enabled && settings.engineeringTools.xfoil.command?.trim());
  const xfoilWasmConfigured = diagnostics ? Boolean(codeAllowed && xfoilWasmCapability?.ready) : Boolean(codeAllowed && settings?.engineeringTools.enabled);
  const modelingConfigured = diagnostics
    ? Boolean(codeAllowed && modelingCapability?.ready)
    : Boolean(settings?.engineeringTools.modeling.enabled && settings.engineeringTools.modeling.artifactRoot?.trim());
  const openFoamConfigured = diagnostics
    ? Boolean(codeAllowed && openFoamCapability?.ready)
    : Boolean(settings?.engineeringTools.openFoam.enabled && settings.engineeringTools.openFoam.command?.trim() && settings.engineeringTools.openFoam.caseRoot?.trim());
  const su2Configured = diagnostics
    ? Boolean(codeAllowed && su2Capability?.ready)
    : Boolean(settings?.engineeringTools.su2.enabled && settings.engineeringTools.su2.command?.trim() && settings.engineeringTools.su2.caseRoot?.trim() && settings.engineeringTools.su2.configFile?.trim());
  const freeCadConfigured = diagnostics
    ? Boolean(codeAllowed && freeCadCapability?.ready)
    : Boolean(settings?.engineeringTools.freeCad.enabled && settings.engineeringTools.freeCad.command?.trim() && settings.engineeringTools.freeCad.scriptPath?.trim());
  const openVspConfigured = diagnostics
    ? Boolean(codeAllowed && openVspCapability?.ready)
    : Boolean(settings?.engineeringTools.openVsp.enabled && settings.engineeringTools.openVsp.command?.trim() && settings.engineeringTools.openVsp.scriptPath?.trim());
  const flightStreamConfigured = Boolean(codeAllowed && flightStreamCapability?.ready);
  const starCcmConfigured = Boolean(codeAllowed && starCcmCapability?.ready);
  const engineeringReady = Boolean(codeAllowed && (xfoilConfigured || xfoilWasmConfigured || modelingConfigured || openFoamConfigured || su2Configured || freeCadConfigured || openVspConfigured));
  const commercialConfigured = diagnostics
    ? Boolean(flightStreamConfigured || starCcmConfigured)
    : Boolean(
        (settings?.engineeringTools.commercialCfd.flightStreamConfigured && settings.engineeringTools.commercialCfd.flightStreamCommand?.trim()) ||
          (settings?.engineeringTools.commercialCfd.starCcmConfigured && settings.engineeringTools.commercialCfd.starCcmCommand?.trim())
      );
  const metadataBlockedReason = !snapshot.project.autonomyPolicy.allowExternalSearch
    ? "Project autonomy blocks external search."
    : (diagnostics?.researchMetadata.blockedReason ?? "외부 접근 또는 metadata 설정 필요");
  const engineeringBlockedReason = !snapshot.project.autonomyPolicy.allowCodeExecution
    ? "Project autonomy blocks code execution."
    : (diagnostics?.engineeringPrograms.find((capability) => capability.target === "all")?.blockedReason ??
      "코드 실행 허용과 XFOIL command 또는 modeling artifact root 필요");
  const commercialBlockedReason = !snapshot.project.autonomyPolicy.allowCodeExecution
    ? "Project autonomy blocks code execution."
    : joinPresent(
        " / ",
        flightStreamCapability?.ready ? "FlightStream adapter ready" : flightStreamCapability?.blockedReason,
        starCcmCapability?.ready ? "STAR-CCM+ adapter ready" : starCcmCapability?.blockedReason
      ) || "FlightStream / STAR-CCM+ command adapter 설정 전까지 차단";

  return [
    {
      id: "metadata",
      label: "OpenAlex metadata",
      badge: metadataReady ? "활성" : "대기",
      detail: metadataReady ? `최대 ${settings?.researchMetadata.maxResults ?? 0}개 논문 메타데이터 수집 가능` : "외부 접근 또는 metadata 설정 필요",
      status: metadataReady ? "ready" : "blocked",
      icon: Globe2
    },
    {
      id: "headless-programs",
      label: "Headless program tools",
      badge: engineeringReady ? "실행 가능" : "설정 필요",
      detail: engineeringReady
        ? `XFOIL ${xfoilConfigured ? "on" : "off"} / XFOIL-WASM ${xfoilWasmConfigured ? "on" : "off"} / mesh ${modelingConfigured ? "on" : "off"} / OpenFOAM ${openFoamConfigured ? "on" : "off"} / SU2 ${su2Configured ? "on" : "off"} / FreeCAD ${freeCadConfigured ? "on" : "off"} / OpenVSP ${openVspConfigured ? "on" : "off"}`
        : "코드 실행 허용과 XFOIL, XFOIL-WASM, parser-valid mesh, OpenFOAM/SU2 case, FreeCAD script, 또는 OpenVSP script 설정 필요",
      status: engineeringReady ? "ready" : "blocked",
      icon: Wrench
    },
    {
      id: "commercial-cfd",
      label: "Commercial CFD",
      badge: commercialConfigured ? "라이선스 확인 필요" : "미설정",
      detail: commercialConfigured ? "설정된 adapter command만 LLM 계획에서 실행 가능" : "FlightStream / STAR-CCM+는 command adapter 설정 전까지 차단",
      status: commercialConfigured ? "ready" : "blocked",
      icon: HardDrive
    }
  ];
}

function buildRuntimeResearchToolReadiness(
  settings: AppSettings | undefined,
  snapshot: ResearchSnapshot,
  diagnostics?: RuntimeToolDiagnostics
): ToolReadinessItem[] {
  const projectExternalAllowed = snapshot.project.autonomyPolicy.allowExternalSearch;
  const projectCodeAllowed = snapshot.project.autonomyPolicy.allowCodeExecution;
  const appExternalAllowed = Boolean(settings?.allowExternalSearch);
  const appCodeAllowed = Boolean(settings?.allowCodeExecution);
  const externalAllowed = appExternalAllowed && projectExternalAllowed;
  const codeAllowed = appCodeAllowed && projectCodeAllowed;
  const metadataReady = Boolean(externalAllowed && (diagnostics ? diagnostics.researchMetadata.ready : settings?.researchMetadata.enabled));
  const flightStreamCapability = diagnostics?.engineeringPrograms.find((capability) => capability.target === "flightstream");
  const starCcmCapability = diagnostics?.engineeringPrograms.find((capability) => capability.target === "starccm");
  const xfoilTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-polar:xfoil");
  const xfoilWasmTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "xfoil-wasm-polar:xfoil-wasm");
  const modelingTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "mesh-inspect:modeling");
  const openFoamTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "openfoam-case-run:openfoam");
  const su2Template = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "su2-case-run:su2");
  const freeCadTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "cad-script-run:freecad");
  const openVspTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "vsp-script-run:openvsp");
  const flightStreamTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "commercial-cfd-run:flightstream");
  const starCcmTemplate = diagnostics?.engineeringProgramRequestTemplates.find((template) => template.id === "commercial-cfd-run:starccm");
  const xfoilReady = diagnostics ? Boolean(codeAllowed && xfoilTemplate?.ready) : Boolean(codeAllowed && settings?.engineeringTools.xfoil.enabled && settings.engineeringTools.xfoil.command?.trim());
  const xfoilWasmReady = diagnostics ? Boolean(codeAllowed && xfoilWasmTemplate?.ready) : Boolean(codeAllowed && settings?.engineeringTools.enabled);
  const modelingReady = diagnostics
    ? Boolean(codeAllowed && modelingTemplate?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.modeling.enabled && settings.engineeringTools.modeling.artifactRoot?.trim());
  const openFoamReady = diagnostics
    ? Boolean(codeAllowed && openFoamTemplate?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.openFoam.enabled && settings.engineeringTools.openFoam.command?.trim() && settings.engineeringTools.openFoam.caseRoot?.trim());
  const su2Ready = diagnostics
    ? Boolean(codeAllowed && su2Template?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.su2.enabled && settings.engineeringTools.su2.command?.trim() && settings.engineeringTools.su2.caseRoot?.trim() && settings.engineeringTools.su2.configFile?.trim());
  const freeCadReady = diagnostics
    ? Boolean(codeAllowed && freeCadTemplate?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.freeCad.enabled && settings.engineeringTools.freeCad.command?.trim() && settings.engineeringTools.freeCad.scriptPath?.trim());
  const openVspReady = diagnostics
    ? Boolean(codeAllowed && openVspTemplate?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.openVsp.enabled && settings.engineeringTools.openVsp.command?.trim() && settings.engineeringTools.openVsp.scriptPath?.trim());
  const flightStreamReady = diagnostics
    ? Boolean(codeAllowed && flightStreamTemplate?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.commercialCfd.flightStreamConfigured && settings.engineeringTools.commercialCfd.flightStreamCommand?.trim());
  const starCcmReady = diagnostics
    ? Boolean(codeAllowed && starCcmTemplate?.ready)
    : Boolean(codeAllowed && settings?.engineeringTools.commercialCfd.starCcmConfigured && settings.engineeringTools.commercialCfd.starCcmCommand?.trim());
  const engineeringReady = xfoilReady || xfoilWasmReady || modelingReady || openFoamReady || su2Ready || freeCadReady || openVspReady;
  const commercialReady = flightStreamReady || starCcmReady;
  const engineeringArtifactBlockedReason = diagnostics?.blockers.find((blocker) => blocker.key === "engineeringArtifacts")?.message;
  const metadataBlockedReason = projectExternalAllowed
    ? (diagnostics?.researchMetadata.blockedReason ?? "외부 접근 또는 OpenAlex metadata 설정이 필요합니다.")
    : "Project autonomy blocks external search.";
  const engineeringBlockedReason = projectCodeAllowed
    ? (engineeringArtifactBlockedReason ?? diagnostics?.engineeringPrograms.find((capability) => capability.target === "all")?.blockedReason ??
      "XFOIL command 또는 modeling artifact root가 필요합니다.")
    : "Project autonomy blocks code execution.";
  const commercialBlockedReason = projectCodeAllowed
    ? joinPresent(
        " / ",
        flightStreamCapability?.ready ? "FlightStream adapter ready" : flightStreamCapability?.blockedReason,
        starCcmCapability?.ready ? "STAR-CCM+ adapter ready" : starCcmCapability?.blockedReason
      ) || "FlightStream / STAR-CCM+ command adapter 설정이 필요합니다."
    : "Project autonomy blocks code execution.";

  return [
    {
      id: "metadata",
      label: "OpenAlex metadata",
      badge: metadataReady ? "Ready" : "Blocked",
      detail: metadataReady
        ? `최대 ${diagnostics?.researchMetadata.maxResults ?? settings?.researchMetadata.maxResults ?? 0}개 논문 메타데이터 수집 가능`
        : metadataBlockedReason,
      status: metadataReady ? "ready" : "blocked",
      icon: Globe2
    },
    {
      id: "headless-programs",
      label: "Headless program tools",
      badge: engineeringReady ? "Ready" : "Blocked",
      detail: engineeringReady
        ? `XFOIL ${xfoilReady ? "ready" : "blocked"} / XFOIL-WASM ${xfoilWasmReady ? "ready" : "blocked"} / mesh ${modelingReady ? "ready" : "blocked"} / OpenFOAM ${openFoamReady ? "ready" : "blocked"} / SU2 ${su2Ready ? "ready" : "blocked"} / FreeCAD ${freeCadReady ? "ready" : "blocked"} / OpenVSP ${openVspReady ? "ready" : "blocked"}`
        : engineeringBlockedReason,
      status: engineeringReady ? "ready" : "blocked",
      icon: Wrench
    },
    {
      id: "commercial-cfd",
      label: "Commercial CFD",
      badge: commercialReady ? "Adapter ready" : "Blocked",
      detail: commercialReady
        ? `FlightStream ${flightStreamReady ? "ready" : "blocked"} / STAR-CCM+ ${starCcmReady ? "ready" : "blocked"}`
        : commercialBlockedReason,
      status: commercialReady ? "ready" : "blocked",
      icon: HardDrive
    }
  ];
}

function recentIntegratedToolRuns(toolRuns: ResearchSnapshot["toolRuns"]): ResearchSnapshot["toolRuns"] {
  const integrated: ResearchSnapshot["toolRuns"] = [];
  for (const toolRun of toolRuns) {
    if (toolRun.toolName === "ResearchMetadataTool" || toolRun.toolName === "EngineeringProgramTool") integrated.push(toolRun);
  }
  return lastItems(integrated, 4);
}

function AgentDuty({ icon: Icon, label }: { icon: IconComponent; label: string }): ReactElement {
  return (
    <div className="duty">
      <Icon size={16} />
      <span>{label}</span>
    </div>
  );
}

function StorageList({ stats }: { stats: SnapshotStats }): ReactElement {
  const rows = useMemo(
    () => [
      { icon: FileText, label: "Raw Sources", value: stats.rawSources },
      { icon: Boxes, label: "Artifacts", value: stats.artifacts },
      { icon: Gauge, label: "Tool Logs", value: stats.toolLogs },
      { icon: MessageSquare, label: "Evidence Ledger", value: stats.evidence },
      { icon: Search, label: "Vector DB", value: stats.chunks },
      { icon: Workflow, label: "Ontology Graph DB", value: stats.graphItems },
      { icon: Database, label: "Projects & Reports", value: stats.storageProjectsAndReports }
    ],
    [stats]
  );

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
  const sessions: ResearchSnapshot["sessions"] = [];
  for (const session of snapshot.sessions) {
    if (!isLegacyStructuredSession(session.title)) sessions.push(session);
  }
  return sessions;
}

function chatMessagesFor(snapshot: ResearchSnapshot, sessionId: string, sessionTitle: string): ResearchSnapshot["artifacts"] {
  const messages: ResearchSnapshot["artifacts"] = [];
  for (const artifact of snapshot.artifacts) {
    const relativePath = artifact.relativePath.replace(/\\/g, "/");
    if (
      artifact.category === "conversation_memo" &&
      (relativePath.includes(`/chat/${sessionId}-`) || artifact.title === `${sessionTitle} 메모`)
    ) {
      messages.push(artifact);
    }
  }
  messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return messages;
}

function chatMessageViews(messages: ResearchSnapshot["artifacts"]): Array<{
  id: string;
  role: "user" | "assistant";
  text: string | undefined;
  createdLabel: string;
}> {
  const views: Array<{
    id: string;
    role: "user" | "assistant";
    text: string | undefined;
    createdLabel: string;
  }> = [];
  for (const message of messages) {
    views.push({
      id: message.id,
      role: chatMessageRole(message),
      text: message.content ?? message.summary,
      createdLabel: new Date(message.createdAt).toLocaleString()
    });
  }
  return views;
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
  return legacyStructuredSessionTitles.has(title);
}

function normalizeSettings(settings: AppSettings): AppSettings {
  const base = {
    ...settings,
    embedding: normalizeEmbedding(settings.embedding),
    researchMetadata: normalizeResearchMetadata(settings.researchMetadata),
    engineeringTools: normalizeEngineeringTools(settings.engineeringTools)
  };
  if (settings.openCodeLlm.source === "api") {
    const provider = settings.openCodeLlm.provider;
    return {
      ...base,
      openCodeLlm: {
        ...settings.openCodeLlm,
        model: settings.openCodeLlm.model || modelOptions[provider][0]
      }
    };
  }
  return {
    ...base,
    openCodeLlm: {
      ...settings.openCodeLlm,
      model: settings.openCodeLlm.model || codexOAuthModels[0]
    }
  };
}

function normalizeRunInput(input: ResearchProjectInput): ResearchProjectInput {
  return {
    ...input,
    autonomyPolicy: {
      ...input.autonomyPolicy,
      maxLoopIterations: normalizeLoopLimit(input.autonomyPolicy.maxLoopIterations)
    }
  };
}

function normalizeLoopLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultGuiLoopLimit;
  }
  return Math.min(maxGuiLoopLimit, Math.floor(parsed));
}

function normalizeEmbedding(embedding: AppSettings["embedding"]): AppSettings["embedding"] {
  return {
    ...embedding,
    model: embedding.model || embeddingModelOptions[embedding.provider][0],
    dimensions: embedding.dimensions || 96
  };
}

function normalizeResearchMetadata(metadata: AppSettings["researchMetadata"] | undefined): AppSettings["researchMetadata"] {
  return {
    enabled: metadata?.enabled ?? true,
    provider: "openalex",
    mailto: metadata?.mailto,
    maxResults: metadata?.maxResults || 5,
    timeoutMs: metadata?.timeoutMs || 15_000
  };
}

function normalizeEngineeringTools(engineeringTools: AppSettings["engineeringTools"] | undefined): AppSettings["engineeringTools"] {
  return {
    enabled: engineeringTools?.enabled ?? false,
    xfoil: {
      enabled: engineeringTools?.xfoil?.enabled ?? false,
      command: engineeringTools?.xfoil?.command ?? "",
      timeoutMs: engineeringTools?.xfoil?.timeoutMs ?? 30_000
    },
    modeling: {
      enabled: engineeringTools?.modeling?.enabled ?? false,
      artifactRoot: engineeringTools?.modeling?.artifactRoot ?? "",
      maxMeshBytes: engineeringTools?.modeling?.maxMeshBytes ?? 20 * 1024 * 1024
    },
    openFoam: {
      enabled: engineeringTools?.openFoam?.enabled ?? false,
      command: engineeringTools?.openFoam?.command ?? "",
      caseRoot: engineeringTools?.openFoam?.caseRoot ?? "",
      workingDirectory: engineeringTools?.openFoam?.workingDirectory ?? "",
      probeArgs: engineeringTools?.openFoam?.probeArgs ?? ["-help"],
      runArgsTemplate: engineeringTools?.openFoam?.runArgsTemplate ?? ["-case", "{case}"],
      timeoutMs: engineeringTools?.openFoam?.timeoutMs ?? 30 * 60_000
    },
    su2: {
      enabled: engineeringTools?.su2?.enabled ?? false,
      command: engineeringTools?.su2?.command ?? "",
      caseRoot: engineeringTools?.su2?.caseRoot ?? "",
      configFile: engineeringTools?.su2?.configFile ?? "",
      workingDirectory: engineeringTools?.su2?.workingDirectory ?? "",
      probeArgs: engineeringTools?.su2?.probeArgs ?? ["--help"],
      runArgsTemplate: engineeringTools?.su2?.runArgsTemplate ?? ["{config}"],
      timeoutMs: engineeringTools?.su2?.timeoutMs ?? 30 * 60_000
    },
    freeCad: {
      enabled: engineeringTools?.freeCad?.enabled ?? false,
      command: engineeringTools?.freeCad?.command ?? "",
      scriptPath: engineeringTools?.freeCad?.scriptPath ?? "",
      workingDirectory: engineeringTools?.freeCad?.workingDirectory ?? "",
      probeArgs: engineeringTools?.freeCad?.probeArgs ?? ["--version"],
      runArgsTemplate: engineeringTools?.freeCad?.runArgsTemplate ?? ["{script}", "--output", "{output}"],
      timeoutMs: engineeringTools?.freeCad?.timeoutMs ?? 30 * 60_000
    },
    openVsp: {
      enabled: engineeringTools?.openVsp?.enabled ?? false,
      command: engineeringTools?.openVsp?.command ?? "",
      scriptPath: engineeringTools?.openVsp?.scriptPath ?? "",
      workingDirectory: engineeringTools?.openVsp?.workingDirectory ?? "",
      probeArgs: engineeringTools?.openVsp?.probeArgs ?? ["-help"],
      runArgsTemplate: engineeringTools?.openVsp?.runArgsTemplate ?? ["-script", "{script}", "-output", "{output}"],
      timeoutMs: engineeringTools?.openVsp?.timeoutMs ?? 30 * 60_000
    },
    commercialCfd: {
      flightStreamConfigured: engineeringTools?.commercialCfd?.flightStreamConfigured ?? false,
      starCcmConfigured: engineeringTools?.commercialCfd?.starCcmConfigured ?? false,
      flightStreamCommand: engineeringTools?.commercialCfd?.flightStreamCommand ?? "",
      flightStreamWorkingDirectory: engineeringTools?.commercialCfd?.flightStreamWorkingDirectory ?? "",
      flightStreamProbeArgs: engineeringTools?.commercialCfd?.flightStreamProbeArgs ?? ["--version"],
      flightStreamRunArgsTemplate: engineeringTools?.commercialCfd?.flightStreamRunArgsTemplate ?? [],
      flightStreamTimeoutMs: engineeringTools?.commercialCfd?.flightStreamTimeoutMs ?? 120_000,
      starCcmCommand: engineeringTools?.commercialCfd?.starCcmCommand ?? "",
      starCcmWorkingDirectory: engineeringTools?.commercialCfd?.starCcmWorkingDirectory ?? "",
      starCcmProbeArgs: engineeringTools?.commercialCfd?.starCcmProbeArgs ?? ["-version"],
      starCcmRunArgsTemplate: engineeringTools?.commercialCfd?.starCcmRunArgsTemplate ?? [],
      starCcmTimeoutMs: engineeringTools?.commercialCfd?.starCcmTimeoutMs ?? 120_000,
      notes: engineeringTools?.commercialCfd?.notes ?? ""
    }
  };
}

function lastItems<T>(values: T[], limit: number): T[] {
  const output: T[] = [];
  const start = Math.max(0, values.length - limit);
  for (let index = start; index < values.length; index += 1) {
    output.push(values[index]);
  }
  return output;
}

function joinPresent(separator: string, ...values: unknown[]): string {
  const parts: string[] = [];
  for (const value of values) {
    if (value) parts.push(String(value));
  }
  return parts.join(separator);
}

function joinFirstStrings(values: string[], limit: number, separator: string): string {
  const parts: string[] = [];
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    parts.push(values[index]);
  }
  return parts.join(separator);
}

function visitedStepSet(iterations: LoopIteration[]): Set<ResearchLoopStep> {
  const steps = new Set<ResearchLoopStep>();
  for (const iteration of iterations) {
    steps.add(iteration.step);
  }
  return steps;
}

function buildSnapshotStats(snapshot: ResearchSnapshot): SnapshotStats {
  const graphItems = snapshot.ontologyEntities.length + snapshot.ontologyRelations.length;
  const runAuditOutputs = snapshot.runAuditOutputs.length;
  const finalOutputs = snapshot.finalOutputs.length;
  const hasReport = snapshot.report ? 1 : 0;
  return {
    results: snapshot.results.length,
    evidence: snapshot.evidence.length,
    normalizedRecords: snapshot.normalizedRecords.length,
    chunks: snapshot.chunks.length,
    graphItems,
    validationResults: snapshot.validationResults.length,
    rawSources: snapshot.sources.length,
    artifacts: snapshot.artifacts.length,
    toolLogs: snapshot.toolRuns.length,
    evidenceLedger: snapshot.evidence.length + countEvidenceRecords(snapshot),
    memoryProjectsAndReports: finalOutputs + runAuditOutputs + hasReport,
    storageProjectsAndReports: finalOutputs + runAuditOutputs || hasReport,
    errorsAndBlockers: snapshot.stepErrors.length + snapshot.runtimeBlockers.length
  };
}

function metricRows(stats: SnapshotStats): Array<{ label: string; value: number }> {
  return [
    { label: "반복", value: stats.results },
    { label: "근거", value: stats.evidence },
    { label: "정규화", value: stats.normalizedRecords },
    { label: "Vector chunk", value: stats.chunks },
    { label: "Graph", value: stats.graphItems },
    { label: "검증", value: stats.validationResults }
  ];
}

function memoryRows(stats: SnapshotStats): Array<{ label: string; value: number }> {
  return [
    { label: "Raw Sources", value: stats.rawSources },
    { label: "Artifacts", value: stats.artifacts },
    { label: "Tool Logs", value: stats.toolLogs },
    { label: "Evidence Ledger", value: stats.evidenceLedger },
    { label: "Vector DB", value: stats.chunks },
    { label: "Ontology Graph DB", value: stats.graphItems },
    { label: "Projects & Reports", value: stats.memoryProjectsAndReports },
    { label: "Errors / Blockers", value: stats.errorsAndBlockers }
  ];
}

function countEvidenceRecords(snapshot: ResearchSnapshot): number {
  let count = 0;
  for (const record of snapshot.normalizedRecords) {
    if (record.kind === "evidence") count += 1;
  }
  return count;
}

function recentBlockerMessages(snapshot: ResearchSnapshot): string[] {
  const messages: string[] = [];
  for (const blocker of lastItems(snapshot.runtimeBlockers, 4)) {
    messages.push(`blocked · ${blocker.requirementKey}: ${blocker.message}`);
  }
  for (const error of lastItems(snapshot.stepErrors, 4)) {
    messages.push(`failed · ${error.step}: ${error.message}`);
  }
  return messages;
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
  return projectStatusLabels[status];
}

function deriveTopic(prompt: string): string {
  let firstLine = "";
  for (const line of prompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      firstLine = trimmed;
      break;
    }
  }
  firstLine ||= "새 연구 프로젝트";
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
