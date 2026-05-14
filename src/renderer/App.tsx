import {
  Bot,
  Boxes,
  CheckCircle2,
  Database,
  FileText,
  FlaskConical,
  FolderKanban,
  Gauge,
  GitBranch,
  Globe2,
  History,
  KeyRound,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RotateCw,
  Save,
  Search,
  Settings,
  Square,
  Target,
  Workflow,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import {
  ResearchLoopStep,
  type AppSettings,
  type CreateProjectInput,
  type LoopIteration,
  type OpenCodeApiLlmSettings,
  type ResearchSnapshot
} from "../core/types.js";
import { getAetherOpsApi } from "./aetherClient.js";

const api = getAetherOpsApi();

const defaultInput: CreateProjectInput = {
  goal: "AetherOps 연구 루프가 근거 기반 결과를 반복적으로 개선하는지 검증",
  topic: "AetherOps 자율 연구 루프",
  scope: "URL/PDF/검색 자료와 OpenCode 실행을 사용하는 로컬 RAG 연구 루프",
  budget: "MVP 로컬 전용 예산",
  autonomyPolicy: {
    toolApproval: "suggested",
    maxLoopIterations: 2,
    allowExternalSearch: true,
    allowCodeExecution: true
  }
};

const providerLabels: Record<OpenCodeApiLlmSettings["provider"], string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  custom: "사용자 지정"
};

const modelOptions: Record<OpenCodeApiLlmSettings["provider"], string[]> = {
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"],
  anthropic: ["claude-sonnet-4.5", "claude-opus-4.1", "claude-haiku-3.5"],
  openrouter: [
    "openai/gpt-5.5",
    "openai/gpt-5.4",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-pro",
    "meta-llama/llama-3.3-70b-instruct"
  ],
  custom: ["gpt-5.5", "claude-sonnet-4.5", "gemini-2.5-pro", "local-model"]
};

const codexOAuthModels = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"];

const defaultApiSettings: OpenCodeApiLlmSettings = {
  source: "api",
  provider: "openai",
  model: modelOptions.openai[0],
  baseUrl: "",
  apiKeyConfigured: false
};

const stepLabels: Record<ResearchLoopStep, { index: string; label: string; flow: "main" | "data" | "agent"; icon: typeof Target }> = {
  [ResearchLoopStep.CreateProject]: { index: "1", label: "연구 프로젝트 생성", flow: "main", icon: FolderKanban },
  [ResearchLoopStep.CreateSubSessions]: { index: "2", label: "하위 대화 세션 생성", flow: "main", icon: MessageSquare },
  [ResearchLoopStep.CreateResearchDb]: { index: "3", label: "연구 DB 생성", flow: "data", icon: Database },
  [ResearchLoopStep.GenerateQuestionsHypothesesEvidence]: {
    index: "4",
    label: "질문/가설/증거 생성",
    flow: "agent",
    icon: GitBranch
  },
  [ResearchLoopStep.RunOpenCode]: { index: "5", label: "OpenCode 실행", flow: "agent", icon: Bot },
  [ResearchLoopStep.StoreResults]: { index: "6", label: "결과/자료 저장", flow: "data", icon: Boxes },
  [ResearchLoopStep.BuildRagContext]: { index: "7", label: "RAG 컨텍스트 구성", flow: "data", icon: Search },
  [ResearchLoopStep.DeriveEvidenceBasedResult]: {
    index: "8",
    label: "근거 기반 결과 도출",
    flow: "agent",
    icon: FlaskConical
  },
  [ResearchLoopStep.FinalizeResearchOutputs]: { index: "완료", label: "최종 연구 성과", flow: "main", icon: CheckCircle2 }
};

const exactSteps = [
  ResearchLoopStep.CreateProject,
  ResearchLoopStep.CreateSubSessions,
  ResearchLoopStep.CreateResearchDb,
  ResearchLoopStep.GenerateQuestionsHypothesesEvidence,
  ResearchLoopStep.RunOpenCode,
  ResearchLoopStep.StoreResults,
  ResearchLoopStep.BuildRagContext,
  ResearchLoopStep.DeriveEvidenceBasedResult,
  ResearchLoopStep.FinalizeResearchOutputs
];

export function App(): ReactElement {
  const [input, setInput] = useState<CreateProjectInput>(defaultInput);
  const [snapshot, setSnapshot] = useState<ResearchSnapshot | undefined>();
  const [events, setEvents] = useState<LoopIteration[]>([]);
  const [llmStatus, setLlmStatus] = useState<{ provider: string; available: boolean }>();
  const [appSettings, setAppSettings] = useState<AppSettings>();
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.llm.status().then(setLlmStatus).catch(() => setLlmStatus({ provider: "unknown", available: false }));
    void api.settings.get().then((settings) => {
      setAppSettings(settings);
      setSettingsDraft(normalizeSettings(settings));
    });
    return api.events.onLoopIteration((iteration) => {
      setEvents((current) => [...current, iteration].slice(-12));
    });
  }, []);

  const currentStep = snapshot?.project.currentStep ?? ResearchLoopStep.CreateProject;
  const latestResult = snapshot?.results.at(-1);
  const activeRun = snapshot?.openCodeRuns.at(-1);
  const ragContext = snapshot?.ragContexts.at(-1);
  const openCodeLlm = settingsDraft?.openCodeLlm;

  const metrics = useMemo(
    () => [
      { label: "질문", value: snapshot?.questions.length ?? 0 },
      { label: "가설", value: snapshot?.hypotheses.length ?? 0 },
      { label: "근거", value: snapshot?.evidence.length ?? 0 },
      { label: "산출물", value: snapshot?.artifacts.length ?? 0 },
      { label: "실행", value: snapshot?.openCodeRuns.length ?? 0 }
    ],
    [snapshot]
  );

  async function createExactWorkflow(): Promise<void> {
    setBusy(true);
    try {
      let next = await api.projects.create(input);
      await api.sessions.createForProject(next.project.id);
      next = await api.researchDb.create(next.project.id);
      next = await api.research.seedQuestions(next.project.id);
      setSnapshot(next);
      setEvents(next.iterations);
    } finally {
      setBusy(false);
    }
  }

  async function startLoop(): Promise<void> {
    if (!snapshot) {
      return;
    }
    setBusy(true);
    try {
      const next = await api.loop.start(snapshot.project.id);
      setSnapshot(next);
      setEvents(next.iterations.slice(-12));
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
    if (snapshot) {
      setSnapshot(await api.loop.resume(snapshot.project.id));
    }
  }

  async function abortLoop(): Promise<void> {
    if (snapshot) {
      setSnapshot(await api.loop.abort(snapshot.project.id));
    }
  }

  async function saveOpenCodeSettings(): Promise<void> {
    if (!settingsDraft) {
      return;
    }
    const toSave: AppSettings =
      settingsDraft.openCodeLlm.source === "api"
        ? {
            ...settingsDraft,
            openCodeLlm: {
              ...settingsDraft.openCodeLlm,
              apiKey: apiKeyInput.trim() || undefined
            }
          }
        : settingsDraft;
    const saved = await api.settings.save(toSave);
    setAppSettings(saved);
    setSettingsDraft(normalizeSettings(saved));
    setApiKeyInput("");
    setSettingsMessage("저장됨");
  }

  async function clearApiKey(): Promise<void> {
    if (!settingsDraft || settingsDraft.openCodeLlm.source !== "api") {
      return;
    }
    const saved = await api.settings.save({
      ...settingsDraft,
      openCodeLlm: {
        ...settingsDraft.openCodeLlm,
        apiKey: ""
      }
    });
    setAppSettings(saved);
    setSettingsDraft(normalizeSettings(saved));
    setApiKeyInput("");
    setSettingsMessage("API 키 삭제됨");
  }

  function setOpenCodeSource(source: "api" | "codex-oauth"): void {
    if (!settingsDraft) {
      return;
    }
    setSettingsDraft({
      ...settingsDraft,
      openCodeLlm:
        source === "api"
          ? {
              ...defaultApiSettings,
              ...(settingsDraft.openCodeLlm.source === "api" ? settingsDraft.openCodeLlm : {})
            }
          : {
              source: "codex-oauth",
              model: settingsDraft.openCodeLlm.source === "codex-oauth" ? settingsDraft.openCodeLlm.model : codexOAuthModels[0]
            }
    });
    setSettingsMessage("");
  }

  function updateApiSettings(patch: Partial<OpenCodeApiLlmSettings>): void {
    if (!settingsDraft || settingsDraft.openCodeLlm.source !== "api") {
      return;
    }
    setSettingsDraft({
      ...settingsDraft,
      openCodeLlm: {
        ...settingsDraft.openCodeLlm,
        ...patch
      }
    });
    setSettingsMessage("");
  }

  function changeProvider(provider: OpenCodeApiLlmSettings["provider"]): void {
    updateApiSettings({
      provider,
      model: modelOptions[provider][0],
      baseUrl: provider === "custom" ? (openCodeLlm?.source === "api" ? openCodeLlm.baseUrl : "") : ""
    });
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">
            <Workflow size={22} />
          </div>
          <div>
            <h1>AetherOps</h1>
            <p>자율 연구 에이전트</p>
          </div>
        </div>

        <div className={`llmPill ${llmStatus?.available ? "online" : "offline"}`}>
          <Bot size={14} />
          <span>{llmStatus?.provider ?? "확인 중"}</span>
          <strong>{llmStatus?.available ? "오케스트레이터 LLM" : "대체 모드"}</strong>
        </div>

        <section className="panel">
          <div className="panelTitle">
            <Settings size={17} />
            <h2>OpenCode LLM</h2>
          </div>
          <div className="segmented">
            <button
              className={openCodeLlm?.source === "api" ? "selected" : ""}
              onClick={() => setOpenCodeSource("api")}
              type="button"
            >
              <KeyRound size={15} />
              API
            </button>
            <button
              className={openCodeLlm?.source === "codex-oauth" ? "selected" : ""}
              onClick={() => setOpenCodeSource("codex-oauth")}
              type="button"
            >
              <Bot size={15} />
              Codex OAuth
            </button>
          </div>

          {openCodeLlm?.source === "api" ? (
            <>
              <div className="fieldGrid">
                <label>
                  제공자
                  <select value={openCodeLlm.provider} onChange={(event) => changeProvider(event.target.value as OpenCodeApiLlmSettings["provider"])}>
                    {Object.entries(providerLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  모델
                  <ModelSelect
                    value={openCodeLlm.model}
                    options={modelOptions[openCodeLlm.provider]}
                    onChange={(model) => updateApiSettings({ model })}
                  />
                </label>
              </div>
              <label>
                Base URL
                <input
                  placeholder="OpenAI 호환 제공자일 때만 입력"
                  value={openCodeLlm.baseUrl ?? ""}
                  onChange={(event) => updateApiSettings({ baseUrl: event.target.value })}
                />
              </label>
              <label>
                API 키
                <input
                  type="password"
                  placeholder={openCodeLlm.apiKeyConfigured ? "이미 설정됨. 비워두면 유지됩니다." : "API 키 입력"}
                  value={apiKeyInput}
                  onChange={(event) => setApiKeyInput(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label>
              모델
              <ModelSelect
                value={openCodeLlm?.source === "codex-oauth" ? openCodeLlm.model ?? codexOAuthModels[0] : codexOAuthModels[0]}
                options={codexOAuthModels}
                onChange={(model) =>
                  settingsDraft &&
                  setSettingsDraft({
                    ...settingsDraft,
                    openCodeLlm: { source: "codex-oauth", model }
                  })
                }
              />
            </label>
          )}

          <div className="settingsActions">
            <button className="primaryButton" onClick={saveOpenCodeSettings} disabled={!settingsDraft}>
              <Save size={16} />
              저장
            </button>
            <button
              onClick={clearApiKey}
              disabled={
                openCodeLlm?.source !== "api" ||
                !appSettings ||
                appSettings.openCodeLlm.source !== "api" ||
                !appSettings.openCodeLlm.apiKeyConfigured
              }
            >
              키 삭제
            </button>
          </div>
          <p className="settingsHint">
            {settingsMessage ||
              (openCodeLlm?.source === "api"
                ? `API 키: ${openCodeLlm.apiKeyConfigured ? "설정됨" : "미설정"}`
                : "OpenCode 실행 엔진에 Codex OAuth 브리지 설정을 전달합니다.")}
          </p>
        </section>

        <section className="panel">
          <div className="panelTitle">
            <Target size={17} />
            <h2>프로젝트</h2>
          </div>
          <label>
            목표
            <textarea value={input.goal} onChange={(event) => setInput({ ...input, goal: event.target.value })} />
          </label>
          <label>
            주제
            <input value={input.topic} onChange={(event) => setInput({ ...input, topic: event.target.value })} />
          </label>
          <label>
            범위
            <textarea value={input.scope} onChange={(event) => setInput({ ...input, scope: event.target.value })} />
          </label>
          <label>
            예산
            <input value={input.budget} onChange={(event) => setInput({ ...input, budget: event.target.value })} />
          </label>
          <div className="fieldGrid">
            <label>
              반복
              <input
                type="number"
                min={1}
                max={8}
                value={input.autonomyPolicy.maxLoopIterations}
                onChange={(event) =>
                  setInput({
                    ...input,
                    autonomyPolicy: { ...input.autonomyPolicy, maxLoopIterations: Number(event.target.value) }
                  })
                }
              />
            </label>
            <label>
              승인
              <select
                value={input.autonomyPolicy.toolApproval}
                onChange={(event) =>
                  setInput({
                    ...input,
                    autonomyPolicy: {
                      ...input.autonomyPolicy,
                      toolApproval: event.target.value as CreateProjectInput["autonomyPolicy"]["toolApproval"]
                    }
                  })
                }
              >
                <option value="manual">수동</option>
                <option value="suggested">제안 후 실행</option>
                <option value="automatic">자동</option>
              </select>
            </label>
          </div>
          <button className="primaryButton" onClick={createExactWorkflow} disabled={busy}>
            {busy ? <Loader2 className="spin" size={17} /> : <FolderKanban size={17} />}
            정확 루프 생성
          </button>
        </section>

        <section className="panel compact">
          <div className="panelTitle">
            <Gauge size={17} />
            <h2>제어</h2>
          </div>
          <div className="controlGrid">
            <button onClick={startLoop} disabled={!snapshot || busy}>
              <Play size={16} />
              시작
            </button>
            <button onClick={pauseLoop} disabled={!snapshot}>
              <Pause size={16} />
              일시정지
            </button>
            <button onClick={resumeLoop} disabled={!snapshot}>
              <RotateCw size={16} />
              재개
            </button>
            <button onClick={abortLoop} disabled={!snapshot}>
              <Square size={16} />
              중단
            </button>
          </div>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">주요 흐름 / 자료 흐름 / 에이전트 제어</p>
            <h2>{snapshot?.project.topic ?? "AetherOps 연구 프로젝트"}</h2>
          </div>
          <div className={`statusPill ${snapshot?.project.status ?? "idle"}`}>{statusLabel(snapshot?.project.status ?? "idle")}</div>
        </header>

        <section className="flowBoard">
          {exactSteps.map((step) => {
            const meta = stepLabels[step];
            const Icon = meta.icon;
            const active = currentStep === step;
            const visited = Boolean(snapshot?.iterations.some((iteration) => iteration.step === step));
            return (
              <div key={step} className={`stepTile ${meta.flow} ${active ? "active" : ""} ${visited ? "visited" : ""}`}>
                <div className="stepIndex">{meta.index}</div>
                <Icon size={21} />
                <span>{meta.label}</span>
              </div>
            );
          })}
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
              <h2>AetherOps 오케스트레이터</h2>
            </div>
            <div className="agentMatrix">
              <AgentDuty icon={Target} label="계획 및 의사결정" />
              <AgentDuty icon={Wrench} label="도구 선택" />
              <AgentDuty icon={FileText} label="결과 분석" />
              <AgentDuty icon={GitBranch} label="질문/가설 갱신" />
              <AgentDuty icon={Workflow} label="다음 단계 제안" />
            </div>
            <div className="latestResult">
              <h3>근거 기반 결과</h3>
              <p>{latestResult?.answer ?? "루프를 실행하면 결과가 표시됩니다."}</p>
            </div>
          </section>

          <section className="panel">
            <div className="panelTitle">
              <History size={17} />
              <h2>이벤트</h2>
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
              <h2>연구 DB</h2>
            </div>
            <StorageList snapshot={snapshot} />
          </section>

          <section className="panel">
            <div className="panelTitle">
              <Bot size={17} />
              <h2>OpenCode 실행</h2>
            </div>
            <div className="runBox">
              <h3>{activeRun?.toolPlan.join(" / ") ?? "대기"}</h3>
              {(activeRun?.logs ?? ["아직 실행 로그가 없습니다."]).map((log) => (
                <p key={log}>{log}</p>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panelTitle">
              <Search size={17} />
              <h2>RAG 컨텍스트</h2>
            </div>
            <div className="ragBox">
              <p>{ragContext?.summary ?? "아직 검색 컨텍스트가 구성되지 않았습니다."}</p>
              <span>
                근거 {ragContext?.evidenceIds.length ?? 0} / 산출물 {ragContext?.artifactIds.length ?? 0}
              </span>
            </div>
          </section>

          <section className="panel wide">
            <div className="panelTitle">
              <CheckCircle2 size={17} />
              <h2>최종 연구 성과</h2>
            </div>
            <div className="finalGrid">
              <FinalItem title="질문 답변" value={snapshot?.report?.answer} />
              <FinalItem title="가설 검증" value={snapshot?.report?.hypothesisVerification} />
              <FinalItem title="정량/정성 결과" value={snapshot?.report?.quantitativeQualitativeResults} />
              <FinalItem title="종합 보고서" value={snapshot?.report?.comprehensiveReport} />
              <FinalItem title="재사용 지식" value={snapshot?.report?.reusableKnowledgeAsset} />
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function ModelSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }): ReactElement {
  const normalizedOptions = options.includes(value) ? options : [value, ...options].filter(Boolean);
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {normalizedOptions.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function AgentDuty({ icon: Icon, label }: { icon: typeof Target; label: string }): ReactElement {
  return (
    <div className="duty">
      <Icon size={16} />
      <span>{label}</span>
    </div>
  );
}

function StorageList({ snapshot }: { snapshot?: ResearchSnapshot }): ReactElement {
  const rows = [
    { icon: Boxes, label: "생성 산출물", value: snapshot?.artifacts.filter((item) => item.category === "generated_artifact").length ?? 0 },
    { icon: FileText, label: "논문/문헌", value: snapshot?.evidence.filter((item) => item.category === "paper_reference").length ?? 0 },
    { icon: Globe2, label: "웹 자료", value: snapshot?.evidence.filter((item) => item.category === "web_source").length ?? 0 },
    { icon: Gauge, label: "실험 로그", value: snapshot?.evidence.filter((item) => item.category === "experiment_log").length ?? 0 },
    { icon: MessageSquare, label: "대화/메모", value: snapshot?.evidence.filter((item) => item.category === "conversation_memo").length ?? 0 }
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

function normalizeSettings(settings: AppSettings): AppSettings {
  if (settings.openCodeLlm.source === "api") {
    const provider = settings.openCodeLlm.provider;
    return {
      ...settings,
      openCodeLlm: {
        ...settings.openCodeLlm,
        model: settings.openCodeLlm.model || modelOptions[provider][0]
      }
    };
  }
  return {
    ...settings,
    openCodeLlm: {
      ...settings.openCodeLlm,
      model: settings.openCodeLlm.model || codexOAuthModels[0]
    }
  };
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    idle: "대기",
    running: "실행 중",
    paused: "일시정지",
    aborted: "중단됨",
    completed: "완료",
    failed: "실패"
  };
  return labels[status] ?? status;
}
