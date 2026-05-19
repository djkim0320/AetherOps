import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createId, nowIso } from "../core/ids.js";
import type { ProjectStorage } from "../core/projectStorage.js";
import { ResearchLoopStep } from "../core/types.js";
import type {
  OpenCodeRun,
  ResearchArtifact,
  ResearchChunk,
  ResearchDatabase,
  ResearchProject,
  ResearchReport,
  ResearchSnapshot,
  ResearchSource,
  ToolRun
} from "../core/types.js";

export class NodeProjectStorage implements ProjectStorage {
  async ensureResearchDb(project: ResearchProject): Promise<ResearchDatabase> {
    const root = normalize(project.projectRoot);
    const paths = {
      sqlitePath: join(root, "research.sqlite"),
      vectorPath: join(root, "vector.sqlite"),
      artifactRoot: join(root, "artifacts"),
      sourceRoot: join(root, "sources"),
      logRoot: join(root, "logs"),
      reportRoot: join(root, "reports"),
      knowledgeRoot: join(root, "knowledge")
    };

    for (const directory of [
      root,
      paths.artifactRoot,
      join(paths.sourceRoot, "web"),
      join(paths.sourceRoot, "papers"),
      join(paths.sourceRoot, "files"),
      paths.logRoot,
      paths.reportRoot,
      paths.knowledgeRoot
    ]) {
      mkdirSync(directory, { recursive: true });
    }

    migrateResearchDb(paths.sqlitePath);
    migrateVectorDb(paths.vectorPath);
    writeProjectManifest(root, project);

    return {
      id: createId("db"),
      projectId: project.id,
      ...paths,
      createdAt: nowIso()
    };
  }

  async writeArtifacts(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    artifacts: ResearchArtifact[]
  ): Promise<ResearchArtifact[]> {
    const written: ResearchArtifact[] = [];
    for (const artifact of artifacts) {
      const relativePath = normalizeArtifactPath(artifact.relativePath, iteration, artifact.title);
      const absolutePath = safeJoin(project.projectRoot, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, artifact.content ?? artifact.summary, "utf8");
      const saved = { ...artifact, relativePath, rawPath: absolutePath };
      written.push(saved);
      upsertJson(database.sqlitePath, "artifacts", saved.id, project.id, saved.createdAt, saved);
    }
    return written;
  }

  async writeRunLog(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    run: OpenCodeRun,
    toolRuns: ToolRun[]
  ): Promise<ResearchSource> {
    const absolutePath = safeJoin(project.projectRoot, `logs/iteration-${iteration}.json`);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${JSON.stringify({ run, toolRuns }, null, 2)}\n`, "utf8");
    const source: ResearchSource = {
      id: `source_${run.id}`,
      projectId: project.id,
      kind: "log",
      title: `Iteration ${iteration} execution log`,
      retrievedAt: nowIso(),
      rawPath: absolutePath,
      metadata: { runId: run.id, iteration, toolRunIds: toolRuns.map((item) => item.id) },
      createdAt: nowIso()
    };
    upsertJson(database.sqlitePath, "sources", source.id, project.id, source.createdAt ?? source.retrievedAt, source);
    for (const toolRun of toolRuns) {
      upsertJson(database.sqlitePath, "tool_runs", toolRun.id, project.id, toolRun.completedAt, toolRun);
    }
    return source;
  }

  async writeSources(
    project: ResearchProject,
    database: ResearchDatabase,
    sources: ResearchSource[]
  ): Promise<ResearchSource[]> {
    const savedSources: ResearchSource[] = [];
    for (const source of sources) {
      const sourceWithPath = source.rawPath ? source : await writeSourceText(project, source);
      savedSources.push(sourceWithPath);
      upsertJson(database.sqlitePath, "sources", sourceWithPath.id, project.id, sourceWithPath.createdAt ?? sourceWithPath.retrievedAt, sourceWithPath);
    }
    return savedSources;
  }

  async writeChunks(project: ResearchProject, database: ResearchDatabase, chunks: ResearchChunk[]): Promise<void> {
    for (const chunk of chunks) {
      upsertJson(database.vectorPath, "chunks", chunk.id, project.id, chunk.createdAt, chunk);
    }
  }

  async writeReportFiles(
    project: ResearchProject,
    database: ResearchDatabase,
    report: ResearchReport,
    markdown: string,
    reusableKnowledge: string
  ): Promise<{ reportPath: string; knowledgePath: string }> {
    const reportPath = safeJoin(project.projectRoot, "reports/final-report.md");
    const knowledgePath = safeJoin(project.projectRoot, "knowledge/reusable-knowledge.md");
    mkdirSync(dirname(reportPath), { recursive: true });
    mkdirSync(dirname(knowledgePath), { recursive: true });
    writeFileSync(reportPath, markdown, "utf8");
    writeFileSync(knowledgePath, reusableKnowledge, "utf8");
    upsertJson(database.sqlitePath, "reports", report.id, project.id, report.createdAt, { ...report, reportPath, knowledgePath });
    return { reportPath, knowledgePath };
  }

  async writeProjectState(snapshot: ResearchSnapshot): Promise<void> {
    const root = normalize(snapshot.project.projectRoot);
    mkdirSync(root, { recursive: true });
    writeProjectManifest(root, snapshot.project);
    writeLoopSpec(root, snapshot);
  }
}

function writeProjectManifest(root: string, project: ResearchProject): void {
  const projectJsonPath = join(root, "project.json");
  const projectMarkdownPath = join(root, "project.md");
  writeFileSync(projectJsonPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  writeFileSync(
    projectMarkdownPath,
    [
      `# ${project.topic}`,
      "",
      `- Project ID: ${project.id}`,
      `- Status: ${project.status}`,
      `- Current step: ${project.currentStep}`,
      `- Created: ${project.createdAt}`,
      `- Updated: ${project.updatedAt}`,
      "",
      "## Goal",
      project.goal,
      "",
      "## Scope",
      project.scope,
      "",
      "## Budget / Constraints",
      project.budget,
      "",
      "## Autonomy Policy",
      `- Tool approval: ${project.autonomyPolicy.toolApproval}`,
      `- Max loop iterations: ${project.autonomyPolicy.maxLoopIterations}`,
      `- External search: ${project.autonomyPolicy.allowExternalSearch ? "allowed" : "blocked"}`,
      `- Code execution: ${project.autonomyPolicy.allowCodeExecution ? "allowed" : "blocked"}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

function writeLoopSpec(root: string, snapshot: ResearchSnapshot): void {
  const loopJsonPath = join(root, "aetherops-loop.json");
  const loopMarkdownPath = join(root, "aetherops-loop.md");
  const spec = buildLoopSpec(snapshot);
  writeFileSync(loopJsonPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  writeFileSync(loopMarkdownPath, renderLoopMarkdown(spec), "utf8");
}

function buildLoopSpec(snapshot: ResearchSnapshot): Record<string, unknown> {
  const project = snapshot.project;
  const visited = new Set(snapshot.iterations.map((iteration) => iteration.step));
  return {
    schema: "aetherops.research-loop.v1",
    project: {
      id: project.id,
      topic: project.topic,
      goal: project.goal,
      scope: project.scope,
      budget: project.budget,
      status: project.status,
      currentStep: project.currentStep,
      projectRoot: project.projectRoot,
      autonomyPolicy: project.autonomyPolicy,
      updatedAt: project.updatedAt
    },
    exactFlow: [
      "1. CREATE_PROJECT",
      "2. CREATE_SUB_SESSIONS",
      "3. CREATE_RESEARCH_DB",
      "4. GENERATE_QUESTIONS_HYPOTHESES_EVIDENCE",
      "5. RUN_OPENCODE",
      "6. STORE_RESULTS",
      "7. BUILD_RAG_CONTEXT",
      "8. DERIVE_EVIDENCE_BASED_RESULT",
      "repeat 5 -> 6 -> 7 -> 8 until convergence or maxLoopIterations",
      "FINALIZE_RESEARCH_OUTPUTS"
    ],
    stages: loopStages.map((stage) => ({
      ...stage,
      state: project.currentStep === stage.step ? "active" : visited.has(stage.step) ? "completed" : "pending"
    })),
    repeatLoop: {
      sequence: [
        ResearchLoopStep.RunOpenCode,
        ResearchLoopStep.StoreResults,
        ResearchLoopStep.BuildRagContext,
        ResearchLoopStep.DeriveEvidenceBasedResult
      ],
      returnTo: ResearchLoopStep.RunOpenCode,
      repeatWhen: [
        "needsMoreEvidence is true",
        "needsMoreAnalysis is true",
        "nextQuestions is not empty",
        "hypothesis verification still needs more evidence"
      ],
      stopWhen: [
        "maxLoopIterations reached",
        "needsMoreEvidence=false and needsMoreAnalysis=false and no nextQuestions",
        "new evidence/artifacts are near zero compared with previous iteration",
        "project status is paused or aborted"
      ]
    },
    agentControl: [
      "계획 및 의사결정",
      "도구 선택 및 실행 지시",
      "결과 해석 및 요약",
      "질문/가설 업데이트",
      "다음 단계 제안"
    ],
    storageModel: {
      sqlite: snapshot.database?.sqlitePath ?? "research.sqlite",
      vectorDb: snapshot.database?.vectorPath ?? "vector.sqlite",
      artifacts: snapshot.database?.artifactRoot ?? "artifacts/",
      sources: snapshot.database?.sourceRoot ?? "sources/",
      logs: snapshot.database?.logRoot ?? "logs/",
      reports: snapshot.database?.reportRoot ?? "reports/",
      knowledge: snapshot.database?.knowledgeRoot ?? "knowledge/"
    },
    counts: {
      sessions: snapshot.sessions.length,
      questions: snapshot.questions.length,
      hypotheses: snapshot.hypotheses.length,
      evidence: snapshot.evidence.length,
      artifacts: snapshot.artifacts.length,
      sources: snapshot.sources.length,
      chunks: snapshot.chunks.length,
      openCodeRuns: snapshot.openCodeRuns.length,
      toolRuns: snapshot.toolRuns.length,
      results: snapshot.results.length,
      events: snapshot.iterations.length
    },
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      focus: session.focus,
      createdAt: session.createdAt
    })),
    finalOutputs: {
      answer: snapshot.report?.answer ?? null,
      hypothesisVerification: snapshot.report?.hypothesisVerification ?? null,
      quantitativeQualitativeResults: snapshot.report?.quantitativeQualitativeResults ?? null,
      comprehensiveReport: snapshot.report?.reportPath ?? "reports/final-report.md",
      reusableKnowledgeAsset: snapshot.report?.knowledgePath ?? "knowledge/reusable-knowledge.md"
    },
    recentEvents: snapshot.iterations.slice(-20).map((iteration) => ({
      step: iteration.step,
      flowKind: iteration.flowKind,
      message: iteration.message,
      createdAt: iteration.createdAt
    }))
  };
}

function renderLoopMarkdown(spec: Record<string, unknown>): string {
  const project = spec.project as Record<string, unknown>;
  const counts = spec.counts as Record<string, number>;
  const stages = spec.stages as Array<Record<string, string>>;
  const sessions = spec.sessions as Array<Record<string, string>>;
  const recentEvents = spec.recentEvents as Array<Record<string, string>>;
  return [
    `# AetherOps Research Loop - ${project.topic}`,
    "",
    "## Current State",
    `- Status: ${project.status}`,
    `- Current step: ${project.currentStep}`,
    `- Project root: ${project.projectRoot}`,
    "",
    "## Exact Research Flow",
    ...stages.map((stage) => `- ${stage.index}. ${stage.title} (${stage.step}) - ${stage.state} / ${stage.flowKind}`),
    "",
    "## Repeat Loop",
    "- RUN_OPENCODE -> STORE_RESULTS -> BUILD_RAG_CONTEXT -> DERIVE_EVIDENCE_BASED_RESULT",
    "- If more evidence, analysis, or next questions are needed, return to RUN_OPENCODE.",
    "- Otherwise create final research outputs.",
    "",
    "## Agent Control",
    "- 계획 및 의사결정",
    "- 도구 선택 및 실행 지시",
    "- 결과 해석 및 요약",
    "- 질문/가설 업데이트",
    "- 다음 단계 제안",
    "",
    "## Storage Counts",
    `- Sessions: ${counts.sessions}`,
    `- Questions: ${counts.questions}`,
    `- Hypotheses: ${counts.hypotheses}`,
    `- Evidence: ${counts.evidence}`,
    `- Artifacts: ${counts.artifacts}`,
    `- Sources: ${counts.sources}`,
    `- RAG chunks: ${counts.chunks}`,
    `- OpenCode runs: ${counts.openCodeRuns}`,
    `- Tool runs: ${counts.toolRuns}`,
    `- Results: ${counts.results}`,
    "",
    "## Sessions",
    ...(sessions.length ? sessions.map((session) => `- ${session.title}: ${session.focus}`) : ["- No chat sessions yet."]),
    "",
    "## Recent Events",
    ...(recentEvents.length
      ? recentEvents.map((event) => `- [${event.flowKind}] ${event.step}: ${event.message}`)
      : ["- No events yet."]),
    ""
  ].join("\n");
}

const loopStages = [
  {
    index: 1,
    step: ResearchLoopStep.CreateProject,
    title: "연구 프로젝트 생성",
    flowKind: "Main Flow",
    description: "연구 목표, 주제, 범위, 예산, 자율성 정책을 저장한다."
  },
  {
    index: 2,
    step: ResearchLoopStep.CreateSubSessions,
    title: "하위 대화 세션 생성",
    flowKind: "Main Flow",
    description: "프로젝트 안에 주제별 연구 세션을 만든다."
  },
  {
    index: 3,
    step: ResearchLoopStep.CreateResearchDb,
    title: "연구 DB 생성",
    flowKind: "Data Flow",
    description: "프로젝트별 독립 SQLite, Vector DB, 파일 저장소를 생성한다."
  },
  {
    index: 4,
    step: ResearchLoopStep.GenerateQuestionsHypothesesEvidence,
    title: "연구 질문/가설/증거 생성",
    flowKind: "Agent Control",
    description: "초기 연구 질문, 검증 가능한 가설, seed evidence를 만든다."
  },
  {
    index: 5,
    step: ResearchLoopStep.RunOpenCode,
    title: "OpenCode 실행",
    flowKind: "Agent Control",
    description: "OpenCode 또는 fallback 어댑터로 분석, 모델링, 시뮬레이션, 스크립트 실행을 수행한다."
  },
  {
    index: 6,
    step: ResearchLoopStep.StoreResults,
    title: "결과물/자료 저장",
    flowKind: "Data Flow",
    description: "생성물, 분석 결과, 로그, 이미지, 논문, URL, 대화 기록을 DB와 파일 저장소에 저장한다."
  },
  {
    index: 7,
    step: ResearchLoopStep.BuildRagContext,
    title: "RAG 기반 자료 검색 및 컨텍스트 구성",
    flowKind: "Data Flow",
    description: "Vector DB에서 관련 자료를 검색하고 다음 실행에 필요한 context를 구성한다."
  },
  {
    index: 8,
    step: ResearchLoopStep.DeriveEvidenceBasedResult,
    title: "근거 기반 결과 도출",
    flowKind: "Agent Control",
    description: "RAG 근거로 질문/가설을 검증하고 다음 질문 또는 종료 판단을 생성한다."
  },
  {
    index: 9,
    step: ResearchLoopStep.FinalizeResearchOutputs,
    title: "최종 연구 성과",
    flowKind: "Main Flow",
    description: "답변, 가설 검증, 정량/정성 결과, 종합 보고서, 재사용 지식 자산을 생성한다."
  }
] as const;

function migrateResearchDb(path: string): void {
  migrateJsonDb(path, ["sources", "artifacts", "tool_runs", "agent_plans", "reports"]);
}

function migrateVectorDb(path: string): void {
  migrateJsonDb(path, ["chunks"]);
}

function migrateJsonDb(path: string, tables: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("pragma journal_mode = WAL");
    for (const table of tables) {
      db.exec(`create table if not exists ${table} (id text primary key, project_id text not null, created_at text not null, data text not null)`);
      db.exec(`create index if not exists idx_${table}_project on ${table}(project_id, created_at)`);
    }
  } finally {
    db.close();
  }
}

function upsertJson(path: string, table: string, id: string, projectId: string, createdAt: string, data: unknown): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      `insert into ${table} (id, project_id, created_at, data) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data`
    ).run(id, projectId, createdAt, JSON.stringify(data));
  } finally {
    db.close();
  }
}

async function writeSourceText(project: ResearchProject, source: ResearchSource): Promise<ResearchSource> {
  const folder = source.kind === "paper" ? "papers" : source.kind === "web" ? "web" : "files";
  const filename = `${sanitizeFilename(source.title)}-${source.id}.json`;
  const rawPath = safeJoin(project.projectRoot, `sources/${folder}/${filename}`);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  return { ...source, rawPath };
}

function normalizeArtifactPath(relativePath: string, iteration: number, title: string): string {
  const fallback = `artifacts/iteration-${iteration}/${sanitizeFilename(title)}.md`;
  const candidate = relativePath.trim() || fallback;
  return candidate.startsWith("artifacts/") ? candidate : `artifacts/iteration-${iteration}/${candidate.replace(/^\/+/, "")}`;
}

function safeJoin(root: string, target: string): string {
  const base = normalize(root);
  const normalizedTarget = normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = isAbsolute(normalizedTarget) ? normalizedTarget : join(base, normalizedTarget);
  const distance = relative(base, resolved);
  if (distance.startsWith("..") || isAbsolute(distance)) {
    throw new Error(`Path escapes project root: ${target}`);
  }
  if (!existsSync(dirname(resolved))) {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  return resolved;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return sanitized || "artifact";
}
