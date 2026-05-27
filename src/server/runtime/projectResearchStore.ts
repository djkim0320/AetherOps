import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createId, nowIso } from "../../core/ids.js";
import type { ProjectStorage } from "../../core/projectStorage.js";
import { ResearchLoopStep } from "../../core/types.js";
import type {
  FinalResearchOutput,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  OpenCodeRun,
  ResearchArtifact,
  ResearchChunk,
  ResearchDatabase,
  ResearchProject,
  ResearchReport,
  ResearchSnapshot,
  ResearchSource,
  RunAuditOutput,
  RuntimeBlocker,
  StepError,
  ToolRun
} from "../../core/types.js";

export class NodeProjectStorage implements ProjectStorage {
  async ensureResearchDb(project: ResearchProject): Promise<ResearchDatabase> {
    const root = normalize(project.projectRoot);
    const paths = {
      sqlitePath: join(root, "project.sqlite"),
      vectorPath: join(root, "context", "vector-links.sqlite"),
      ontologyPath: join(root, "context", "ontology-links.sqlite"),
      artifactRoot: join(root, "artifacts"),
      sourceRoot: join(root, "sources"),
      logRoot: join(root, "logs"),
      reportRoot: join(root, "reports"),
      knowledgeRoot: join(root, "knowledge"),
      ontologyRoot: join(root, "ontology"),
      exportsRoot: join(root, "exports"),
      errorsRoot: join(root, "errors"),
      contextRoot: join(root, "context"),
      statePath: join(root, "state.json")
    };

    for (const directory of [
      root,
      paths.contextRoot,
      paths.artifactRoot,
      join(paths.sourceRoot, "web"),
      join(paths.sourceRoot, "papers"),
      join(paths.sourceRoot, "files"),
      paths.logRoot,
      paths.reportRoot,
      paths.knowledgeRoot,
      paths.ontologyRoot,
      paths.exportsRoot,
      paths.errorsRoot
    ]) {
      mkdirSync(directory, { recursive: true });
    }

    migrateResearchDb(paths.sqlitePath);
    migrateVectorDb(paths.vectorPath);
    migrateOntologyDb(paths.ontologyPath);
    writeProjectManifest(root, project);
    writeFileSync(paths.statePath, `${JSON.stringify({ project, updatedAt: nowIso() }, null, 2)}\n`, "utf8");

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
      const workspaceSource = isExternalSource(sourceWithPath) ? stripExternalRawPayload(sourceWithPath) : sourceWithPath;
      upsertJson(database.sqlitePath, "sources", workspaceSource.id, project.id, workspaceSource.createdAt ?? workspaceSource.retrievedAt, workspaceSource);
    }
    return savedSources;
  }

  async writeChunks(project: ResearchProject, database: ResearchDatabase, chunks: ResearchChunk[]): Promise<void> {
    for (const chunk of chunks) {
      upsertJson(database.vectorPath, "chunks", chunk.id, project.id, chunk.createdAt, chunk);
    }
  }

  async writeOntologyGraph(
    project: ResearchProject,
    database: ResearchDatabase,
    graph: {
      entities: OntologyEntity[];
      relations: OntologyRelation[];
      constraints: OntologyConstraint[];
      exportedAt: string;
    }
  ): Promise<{ ontologyExportPath: string; ontologyNtPath: string }> {
    const ontologyExportPath = safeJoin(project.projectRoot, "ontology/project-graph.json");
    const ontologyNtPath = safeJoin(project.projectRoot, "ontology/project-graph.nt");
    const ontologyPath = database.ontologyPath ?? safeJoin(project.projectRoot, "ontology.sqlite");
    writeFileSync(ontologyExportPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    writeFileSync(ontologyNtPath, toNTriples(graph), "utf8");

    for (const entity of graph.entities) {
      upsertJson(ontologyPath, "ontology_entities", entity.id, project.id, entity.createdAt, entity);
    }
    for (const relation of graph.relations) {
      upsertJson(ontologyPath, "ontology_relations", relation.id, project.id, relation.createdAt, relation);
    }
    for (const constraint of graph.constraints) {
      upsertJson(ontologyPath, "ontology_constraints", constraint.id, project.id, constraint.createdAt, constraint);
    }

    return { ontologyExportPath, ontologyNtPath };
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

  async writeFinalOutputFiles(
    project: ResearchProject,
    database: ResearchDatabase,
    output: FinalResearchOutput,
    graphExport: unknown,
    artifactPackage: unknown,
    evidenceCitations: unknown,
    hypothesisVerification: unknown
  ): Promise<{ reportPath: string; knowledgePath: string; ontologyExportPath: string; artifactPackagePath: string }> {
    const reportPath = safeJoin(project.projectRoot, "reports/final-report.md");
    const knowledgePath = safeJoin(project.projectRoot, "knowledge/reusable-knowledge.md");
    const citationsPath = safeJoin(project.projectRoot, "exports/evidence-citations.json");
    const verificationPath = safeJoin(project.projectRoot, "exports/hypothesis-verification.json");
    const ontologyExportPath = safeJoin(project.projectRoot, "ontology/project-graph.json");
    const ontologyNtPath = safeJoin(project.projectRoot, "ontology/project-graph.nt");
    const artifactPackagePath = safeJoin(project.projectRoot, "exports/artifact-package.json");

    writeFileSync(reportPath, output.markdownReport, "utf8");
    writeFileSync(knowledgePath, output.reusableKnowledgeAsset, "utf8");
    writeFileSync(citationsPath, `${JSON.stringify(evidenceCitations, null, 2)}\n`, "utf8");
    writeFileSync(verificationPath, `${JSON.stringify(hypothesisVerification, null, 2)}\n`, "utf8");
    writeFileSync(ontologyExportPath, `${JSON.stringify(graphExport, null, 2)}\n`, "utf8");
    writeFileSync(ontologyNtPath, toNTriples(graphExport), "utf8");
    writeFileSync(artifactPackagePath, `${JSON.stringify(artifactPackage, null, 2)}\n`, "utf8");

    const saved = { ...output, reportPath, ontologyExportPath, artifactPackagePath };
    upsertJson(database.sqlitePath, "final_outputs", output.id, project.id, output.createdAt, saved);
    return { reportPath, knowledgePath, ontologyExportPath, artifactPackagePath };
  }

  async writeRunAuditFiles(
    project: ResearchProject,
    database: ResearchDatabase,
    output: RunAuditOutput
  ): Promise<{ reportPath: string; jsonPath: string }> {
    const reportPath = safeJoin(project.projectRoot, "reports/run-audit.md");
    const jsonPath = safeJoin(project.projectRoot, "exports/run-audit.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    mkdirSync(dirname(jsonPath), { recursive: true });
    const saved = { ...output, reportPath, jsonPath };
    writeFileSync(reportPath, output.markdownReport, "utf8");
    writeFileSync(jsonPath, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    upsertJson(database.sqlitePath, "run_audit_outputs", output.id, project.id, output.createdAt, saved);
    return { reportPath, jsonPath };
  }

  async writeRuntimeBlocker(project: ResearchProject, blocker: RuntimeBlocker): Promise<void> {
    const path = safeJoin(project.projectRoot, "errors/runtime-blockers.jsonl");
    appendFileSync(path, `${JSON.stringify(blocker)}\n`, "utf8");
  }

  async writeStepError(project: ResearchProject, error: StepError): Promise<void> {
    const path = safeJoin(project.projectRoot, "errors/step-errors.jsonl");
    appendFileSync(path, `${JSON.stringify(error)}\n`, "utf8");
  }

  async writeProjectState(snapshot: ResearchSnapshot): Promise<void> {
    const root = normalize(snapshot.project.projectRoot);
    mkdirSync(root, { recursive: true });
    writeProjectManifest(root, snapshot.project);
    writeLoopSpec(root, snapshot);
    writeFileSync(join(root, "state.json"), `${JSON.stringify(buildLoopSpec(snapshot), null, 2)}\n`, "utf8");
  }
}

function writeProjectManifest(root: string, project: ResearchProject): void {
  writeFileSync(join(root, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
  writeFileSync(
    join(root, "project.md"),
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
      project.budget
    ].join("\n"),
    "utf8"
  );
}

function writeLoopSpec(root: string, snapshot: ResearchSnapshot): void {
  const spec = buildLoopSpec(snapshot);
  writeFileSync(join(root, "aetherops-loop.json"), `${JSON.stringify(spec, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "aetherops-loop.md"), renderLoopMarkdown(spec), "utf8");
}

function buildLoopSpec(snapshot: ResearchSnapshot): Record<string, unknown> {
  const project = snapshot.project;
  const visited = new Set(snapshot.iterations.map((iteration) => iteration.step));
  return {
    schema: "aetherops.research-loop.v2",
    project: {
      id: project.id,
      topic: project.topic,
      goal: project.goal,
      status: project.status,
      currentStep: project.currentStep,
      projectRoot: project.projectRoot,
      autonomyPolicy: project.autonomyPolicy,
      updatedAt: project.updatedAt
    },
    exactFlow: [
      "1. CREATE_RESEARCH_DB",
      "2. INPUT_RESEARCH_QUESTION_HYPOTHESIS",
      "3. BUILD_RESEARCH_SPECIFICATION",
      "4. PLAN_RESEARCH",
      "5. EXECUTE_TOOLS",
      "6. NORMALIZE_DATA",
      "7. BUILD_VECTOR_INDEX",
      "8. BUILD_ONTOLOGY_GRAPH",
      "9. REASON_AND_VALIDATE",
      "10. SYNTHESIZE_AND_EVALUATE",
      "11. DECIDE_CONTINUATION",
      "12. FINALIZE_OUTPUTS"
    ],
    stages: loopStages.map((stage) => ({
      ...stage,
      state: project.currentStep === stage.step ? "active" : visited.has(stage.step) ? "completed" : "pending"
    })),
    loopBack: {
      from: ResearchLoopStep.DecideContinuation,
      to: ResearchLoopStep.PlanResearch,
      condition: "shouldContinue=true"
    },
    persistentResearchMemory: buildPersistentMemorySummary(snapshot),
    counts: {
      sessions: snapshot.sessions.length,
      questions: snapshot.questions.length,
      hypotheses: snapshot.hypotheses.length,
      evidence: snapshot.evidence.length,
      artifacts: snapshot.artifacts.length,
      normalizedRecords: snapshot.normalizedRecords.length,
      chunks: snapshot.chunks.length,
      ontologyEntities: snapshot.ontologyEntities.length,
      ontologyRelations: snapshot.ontologyRelations.length,
      validationResults: snapshot.validationResults.length,
      continuationDecisions: snapshot.continuationDecisions.length,
      runtimeBlockers: snapshot.runtimeBlockers.length,
      stepErrors: snapshot.stepErrors.length,
      results: snapshot.results.length,
      events: snapshot.iterations.length
    },
    latestSpecification: snapshot.specifications.at(-1),
    latestPlan: snapshot.researchPlans.at(-1),
    latestContinuationDecision: snapshot.continuationDecisions.at(-1),
    finalOutput: snapshot.finalOutputs.at(-1),
    recentEvents: snapshot.iterations.slice(-20)
  };
}

function buildPersistentMemorySummary(snapshot: ResearchSnapshot): Record<string, unknown> {
  const globalRecords = snapshot.normalizedRecords.filter((record) => record.memoryScope === "global");
  const projectRecords = snapshot.normalizedRecords.filter((record) => record.memoryScope !== "global");
  const globalChunks = snapshot.chunks.filter((chunk) => chunk.memoryScope === "global");
  const projectChunks = snapshot.chunks.filter((chunk) => chunk.memoryScope !== "global");
  const globalEntities = snapshot.ontologyEntities.filter((entity) => entity.memoryScope === "global");
  const projectEntities = snapshot.ontologyEntities.filter((entity) => entity.memoryScope !== "global");
  const globalRelations = snapshot.ontologyRelations.filter((relation) => relation.memoryScope === "global");
  const projectRelations = snapshot.ontologyRelations.filter((relation) => relation.memoryScope !== "global");

  return {
    globalResearchMemory: {
      normalizedRecords: globalRecords.length,
      vectorChunks: globalChunks.length,
      ontologyEntities: globalEntities.length,
      ontologyRelations: globalRelations.length
    },
    projectWorkspace: {
      rawSources: snapshot.sources.length,
      artifacts: snapshot.artifacts.length,
      toolLogs: snapshot.toolRuns.length,
      evidenceLedger: snapshot.evidence.length,
      normalizedRecords: projectRecords.length,
      vectorChunks: projectChunks.length,
      ontologyEntities: projectEntities.length,
      ontologyRelations: projectRelations.length,
      projectsAndReports: snapshot.finalOutputs.length || (snapshot.report ? 1 : 0),
      errorsAndBlockers: snapshot.stepErrors.length + snapshot.runtimeBlockers.length
    }
  };
}

function renderLoopMarkdown(spec: Record<string, unknown>): string {
  const project = spec.project as Record<string, unknown>;
  const stages = spec.stages as Array<Record<string, string>>;
  const counts = spec.counts as Record<string, number>;
  const memory = spec.persistentResearchMemory as Record<string, Record<string, number>>;
  const globalMemory = memory.globalResearchMemory ?? {};
  const projectWorkspace = memory.projectWorkspace ?? {};
  return [
    `# AetherOps 12-Step Research Loop - ${project.topic}`,
    "",
    "## Current State",
    `- Status: ${project.status}`,
    `- Current step: ${project.currentStep}`,
    `- Project root: ${project.projectRoot}`,
    "",
    "## Flow",
    ...stages.map((stage) => `- ${stage.index}. ${stage.title} (${stage.step}) - ${stage.state} / ${stage.flowKind}`),
    "",
    "## Loop Rule",
    "- Step 11 returns to Step 4 when shouldContinue=true.",
    "- Step 11 goes to Step 12 when evidence is sufficient or limits are reached.",
    "",
    "## Counts",
    ...Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Persistent Research Memory",
    "- Global Research Memory",
    ...Object.entries(globalMemory).map(([key, value]) => `  - ${key}: ${value}`),
    "- Project Workspace",
    ...Object.entries(projectWorkspace).map(([key, value]) => `  - ${key}: ${value}`),
    ""
  ].join("\n");
}

const loopStages = [
  { index: 1, step: ResearchLoopStep.CreateResearchDb, title: "연구 DB 생성", flowKind: "Storage Flow" },
  { index: 2, step: ResearchLoopStep.InputResearchQuestionHypothesis, title: "연구 질문 및 가설 입력", flowKind: "Main Flow" },
  { index: 3, step: ResearchLoopStep.BuildResearchSpecification, title: "연구 명세 수립", flowKind: "Agent Control" },
  { index: 4, step: ResearchLoopStep.PlanResearch, title: "연구 계획 수립", flowKind: "Agent Control" },
  { index: 5, step: ResearchLoopStep.ExecuteTools, title: "도구 실행 및 연구 수행", flowKind: "Agent Control" },
  { index: 6, step: ResearchLoopStep.NormalizeData, title: "데이터 수집 및 정규화", flowKind: "Storage Flow" },
  { index: 7, step: ResearchLoopStep.BuildVectorIndex, title: "임베딩 및 벡터 구조화", flowKind: "Knowledge Flow" },
  { index: 8, step: ResearchLoopStep.BuildOntologyGraph, title: "온톨로지 기반 구조화", flowKind: "Knowledge Flow" },
  { index: 9, step: ResearchLoopStep.ReasonAndValidate, title: "추론 및 검증", flowKind: "Agent Control" },
  { index: 10, step: ResearchLoopStep.SynthesizeAndEvaluate, title: "결과 합성 및 가설 평가", flowKind: "Agent Control" },
  { index: 11, step: ResearchLoopStep.DecideContinuation, title: "계속 연구?", flowKind: "Loop Back" },
  { index: 12, step: ResearchLoopStep.FinalizeOutputs, title: "최종 결과 도출", flowKind: "Output Flow" }
] as const;

function migrateResearchDb(path: string): void {
  migrateJsonDb(path, [
    "sources",
    "artifacts",
    "tool_runs",
    "agent_plans",
    "research_inputs",
    "research_specifications",
    "research_plans",
    "project_record_links",
    "project_chunk_links",
    "project_entity_links",
    "project_relation_links",
    "project_context_snapshots",
    "normalized_records",
    "hybrid_contexts",
    "validation_results",
    "continuation_decisions",
    "final_outputs",
    "run_audit_outputs",
    "benchmark_plans",
    "runtime_blockers",
    "step_errors",
    "reports"
  ]);
}

function migrateVectorDb(path: string): void {
  migrateJsonDb(path, ["chunks"]);
}

function migrateOntologyDb(path: string): void {
  migrateJsonDb(path, ["ontology_entities", "ontology_relations", "ontology_constraints"]);
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
  const rawPath = isExternalSource(source)
    ? safeMainJoin(project.projectRoot, `sources/${folder}/${filename}`)
    : safeJoin(project.projectRoot, `sources/${folder}/${filename}`);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeFileSync(rawPath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  return { ...source, rawPath };
}

function isExternalSource(source: ResearchSource): boolean {
  return (source.kind === "web" || source.kind === "paper") && Boolean(source.url || source.doi);
}

function stripExternalRawPayload(source: ResearchSource): ResearchSource {
  const metadata = { ...source.metadata };
  delete metadata.rawText;
  return { ...source, metadata };
}

function safeMainJoin(projectRoot: string, target: string): string {
  const root = mainFilesRoot(projectRoot);
  const normalizedTarget = normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = join(root, normalizedTarget);
  const distance = relative(root, resolved);
  if (distance.startsWith("..") || isAbsolute(distance)) {
    throw new Error(`Path escapes main research memory root: ${target}`);
  }
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function mainFilesRoot(projectRoot: string): string {
  const root = normalize(projectRoot);
  const parent = dirname(root);
  if (basename(parent).toLowerCase() === "projects") {
    return join(dirname(parent), "main", "files");
  }
  return join(parent, "main", "files");
}

function normalizeArtifactPath(relativePath: string, iteration: number, title: string): string {
  const defaultRelativePath = `artifacts/iteration-${iteration}/${sanitizeFilename(title)}.md`;
  const candidate = relativePath.trim() || defaultRelativePath;
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
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function sanitizeFilename(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return sanitized || "artifact";
}

function toNTriples(graphExport: unknown): string {
  const graph = graphExport as { entities?: Array<{ id: string; label: string }>; relations?: Array<{ subjectId: string; predicate: string; objectId: string }> };
  const labels = new Map((graph.entities ?? []).map((entity) => [entity.id, entity.label]));
  return (graph.relations ?? [])
    .map((relation) => `<urn:aetherops:${relation.subjectId}> <urn:aetherops:${relation.predicate}> <urn:aetherops:${relation.objectId}> . # ${labels.get(relation.subjectId) ?? relation.subjectId} -> ${labels.get(relation.objectId) ?? relation.objectId}`)
    .join("\n");
}
