import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createId, nowIso } from "../../../core/shared/ids.js";
import type { ProjectStorage } from "../../../core/storage/projectStorage.js";
import { dedupeSourcesByIdUrlDoi } from "../../../core/evidence/sourceDedupe.js";
import { ResearchLoopStep } from "../../../core/shared/types.js";
import { writePdfReport } from "../output/pdfReportRenderer.js";
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
  ResearchSnapshot,
  ResearchSource,
  RunAuditOutput,
  RuntimeBlocker,
  StepError,
  ToolRun
} from "../../../core/shared/types.js";

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
    writeJsonFileSync(paths.statePath, { project, updatedAt: nowIso() });

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
    return withJsonUpserter(database.sqlitePath, (sqlite) => {
      for (const artifact of artifacts) {
        const relativePath = normalizeArtifactPath(artifact.relativePath, iteration, artifact.title);
        const absolutePath = safeJoin(project.projectRoot, relativePath);
        writeTextFileSync(absolutePath, artifact.content ?? artifact.summary, artifact.mimeType === "text/markdown" || /\.md$/i.test(absolutePath));
        const saved = { ...artifact, relativePath, rawPath: absolutePath };
        written.push(saved);
        sqlite.upsert("artifacts", saved.id, project.id, saved.createdAt, saved);
      }
      return written;
    });
  }

  async writeRunLog(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    run: OpenCodeRun,
    toolRuns: ToolRun[]
  ): Promise<ResearchSource> {
    const absolutePath = safeJoin(project.projectRoot, `logs/iteration-${iteration}.json`);
    writeJsonFileSync(absolutePath, { run, toolRuns });
    const source: ResearchSource = {
      id: `source_${run.id}`,
      projectId: project.id,
      kind: "log",
      title: `Iteration ${iteration} execution log`,
      retrievedAt: nowIso(),
      rawPath: absolutePath,
      metadata: { runId: run.id, iteration, toolRunIds: toolRunIds(toolRuns) },
      createdAt: nowIso()
    };
    withJsonUpserter(database.sqlitePath, (sqlite) => {
      sqlite.upsert("sources", source.id, project.id, source.createdAt ?? source.retrievedAt, source);
      for (const toolRun of toolRuns) {
        sqlite.upsert("tool_runs", toolRun.id, project.id, toolRun.completedAt, toolRun);
      }
    });
    return source;
  }

  async writeSources(
    project: ResearchProject,
    database: ResearchDatabase,
    sources: ResearchSource[]
  ): Promise<ResearchSource[]> {
    const dedupedSources = dedupeSourcesByIdUrlDoi(sources);
    if (!dedupedSources.length) return [];
    const savedSources: ResearchSource[] = [];
    const sqlite = createLazyJsonUpserter(database.sqlitePath);
    try {
      for (const source of dedupedSources) {
        const sourceWithPath = source.rawPath ? source : await writeSourceText(project, source);
        savedSources.push(sourceWithPath);
        const workspaceSource = isExternalSource(sourceWithPath) ? stripExternalRawPayload(sourceWithPath) : sourceWithPath;
        sqlite.upsert("sources", workspaceSource.id, project.id, workspaceSource.createdAt ?? workspaceSource.retrievedAt, workspaceSource);
      }
    } finally {
      sqlite.close();
    }
    return savedSources;
  }

  async writeChunks(project: ResearchProject, database: ResearchDatabase, chunks: ResearchChunk[]): Promise<void> {
    withJsonUpserter(database.vectorPath, (sqlite) => {
      for (const chunk of chunks) {
        sqlite.upsert("chunks", chunk.id, project.id, chunk.createdAt, chunk);
      }
    });
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
    writeJsonFileSync(ontologyExportPath, graph);
    writeFileSync(ontologyNtPath, toNTriples(graph), "utf8");

    withJsonUpserter(ontologyPath, (sqlite) => {
      for (const entity of graph.entities) {
        sqlite.upsert("ontology_entities", entity.id, project.id, entity.createdAt, entity);
      }
      for (const relation of graph.relations) {
        sqlite.upsert("ontology_relations", relation.id, project.id, relation.createdAt, relation);
      }
      for (const constraint of graph.constraints) {
        sqlite.upsert("ontology_constraints", constraint.id, project.id, constraint.createdAt, constraint);
      }
    });

    return { ontologyExportPath, ontologyNtPath };
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
    const { reportPath, knowledgePath } = reportKnowledgePaths(project);
    const citationsPath = safeJoin(project.projectRoot, "exports/evidence-citations.json");
    const verificationPath = safeJoin(project.projectRoot, "exports/hypothesis-verification.json");
    const ontologyExportPath = safeJoin(project.projectRoot, "ontology/project-graph.json");
    const ontologyNtPath = safeJoin(project.projectRoot, "ontology/project-graph.nt");
    const artifactPackagePath = safeJoin(project.projectRoot, "exports/artifact-package.json");
    const stagingRoot = finalOutputStagingRoot(project, output);
    const targets = {
      report: finalOutputTarget(project, stagingRoot, reportPath),
      knowledge: finalOutputTarget(project, stagingRoot, knowledgePath),
      citations: finalOutputTarget(project, stagingRoot, citationsPath),
      verification: finalOutputTarget(project, stagingRoot, verificationPath),
      ontologyJson: finalOutputTarget(project, stagingRoot, ontologyExportPath),
      ontologyNt: finalOutputTarget(project, stagingRoot, ontologyNtPath),
      artifactPackage: finalOutputTarget(project, stagingRoot, artifactPackagePath)
    };

    try {
      await writePdfReport({
        title: project.topic,
        projectId: project.id,
        markdown: output.markdownReport,
        outputPath: targets.report.stagedPath,
        createdAt: output.createdAt
      });
      writeMarkdownFileSync(targets.knowledge.stagedPath, output.reusableKnowledgeAsset);
      writeJsonFileSync(targets.citations.stagedPath, evidenceCitations);
      writeJsonFileSync(targets.verification.stagedPath, hypothesisVerification);
      writeJsonFileSync(targets.ontologyJson.stagedPath, graphExport);
      writeFileSync(targets.ontologyNt.stagedPath, toNTriples(graphExport), "utf8");
      writeJsonFileSync(targets.artifactPackage.stagedPath, artifactPackage);

      const saved = { ...output, reportPath, ontologyExportPath, artifactPackagePath };
      commitFinalOutputFiles(database, project, output, Object.values(targets), saved);
      return { reportPath, knowledgePath, ontologyExportPath, artifactPackagePath };
    } finally {
      safeRemove(stagingRoot);
    }
  }

  async writeRunAuditFiles(
    project: ResearchProject,
    database: ResearchDatabase,
    output: RunAuditOutput
  ): Promise<{ reportPath: string; jsonPath: string }> {
    const reportPath = safeJoin(project.projectRoot, "reports/run-audit.md");
    const jsonPath = safeJoin(project.projectRoot, "exports/run-audit.json");
    const saved = { ...output, reportPath, jsonPath };
    writeMarkdownFileSync(reportPath, output.markdownReport);
    writeJsonFileSync(jsonPath, saved);
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
    const loopSpec = buildLoopSpec(snapshot);
    writeLoopSpec(root, loopSpec);
    writeJsonFileSync(join(root, "state.json"), loopSpec);
  }
}

function reportKnowledgePaths(project: ResearchProject): { reportPath: string; knowledgePath: string } {
  return {
    reportPath: safeJoin(project.projectRoot, "reports/final-report.pdf"),
    knowledgePath: safeJoin(project.projectRoot, "knowledge/reusable-knowledge.md")
  };
}

interface FinalOutputFileTarget {
  finalPath: string;
  stagedPath: string;
  backupPath: string;
}

function finalOutputStagingRoot(project: ResearchProject, output: FinalResearchOutput): string {
  const root = safeJoin(project.projectRoot, `.aetherops-final-staging-${sanitizeFilename(output.id)}-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function finalOutputTarget(project: ResearchProject, stagingRoot: string, finalPath: string): FinalOutputFileTarget {
  const projectRoot = normalize(project.projectRoot);
  const relativeFinalPath = relative(projectRoot, finalPath);
  if (relativeFinalPath.startsWith("..") || isAbsolute(relativeFinalPath)) {
    throw new Error(`Final output path escapes project root: ${finalPath}`);
  }
  const stagedPath = join(stagingRoot, "files", relativeFinalPath);
  const backupPath = join(stagingRoot, "backup", relativeFinalPath);
  mkdirSync(dirname(stagedPath), { recursive: true });
  mkdirSync(dirname(backupPath), { recursive: true });
  return { finalPath, stagedPath, backupPath };
}

function commitFinalOutputFiles(
  database: ResearchDatabase,
  project: ResearchProject,
  output: FinalResearchOutput,
  targets: FinalOutputFileTarget[],
  saved: FinalResearchOutput
): void {
  const installed: FinalOutputFileTarget[] = [];
  const backups: FinalOutputFileTarget[] = [];
  let databaseUpdated = false;
  try {
    for (const target of targets) {
      if (existsSync(target.finalPath)) {
        renameSync(target.finalPath, target.backupPath);
        backups.push(target);
      }
    }
    for (const target of targets) {
      renameSync(target.stagedPath, target.finalPath);
      installed.push(target);
    }
    upsertJson(database.sqlitePath, "final_outputs", output.id, project.id, output.createdAt, saved);
    databaseUpdated = true;
    for (const target of backups) safeRemove(target.backupPath);
  } catch (error) {
    if (!databaseUpdated) {
      for (const target of [...installed].reverse()) safeRemove(target.finalPath);
      for (const target of [...backups].reverse()) {
        if (existsSync(target.backupPath)) {
          safeRemove(target.finalPath);
          renameSync(target.backupPath, target.finalPath);
        }
      }
    }
    throw error;
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    return;
  }
}
function writeProjectManifest(root: string, project: ResearchProject): void {
  writeJsonFileSync(join(root, "project.json"), project);
  writeMarkdownFileSync(
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
    ].join("\n")
  );
}

function writeLoopSpec(root: string, spec: Record<string, unknown>): void {
  writeJsonFileSync(join(root, "aetherops-loop.json"), spec);
  writeMarkdownFileSync(join(root, "aetherops-loop.md"), renderLoopMarkdown(spec));
}

function writeJsonFileSync(path: string, data: unknown): void {
  writeTextFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function writeTextFileSync(path: string, content: string, markdown = false): void {
  writeFileSync(path, markdown ? withOptionalMarkdownBom(content) : content, "utf8");
}

function writeMarkdownFileSync(path: string, markdown: string): void {
  writeTextFileSync(path, markdown, true);
}

function withOptionalMarkdownBom(markdown: string): string {
  if (!shouldWriteMarkdownBom() || markdown.startsWith("\uFEFF")) return markdown;
  return `\uFEFF${markdown}`;
}

function shouldWriteMarkdownBom(): boolean {
  const setting = process.env.AETHEROPS_MARKDOWN_BOM?.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(setting ?? "")) return true;
  if (["false", "0", "no", "off"].includes(setting ?? "")) return false;
  return process.platform === "win32";
}

function buildLoopSpec(snapshot: ResearchSnapshot): Record<string, unknown> {
  const project = snapshot.project;
  const visited = new Set<ResearchLoopStep>();
  for (const iteration of snapshot.iterations) {
    visited.add(iteration.step);
  }
  const stages: Array<(typeof loopStages)[number] & { state: string }> = [];
  for (const stage of loopStages) {
    stages.push({
      ...stage,
      state: project.currentStep === stage.step ? "active" : visited.has(stage.step) ? "completed" : "pending"
    });
  }
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
    stages,
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
  const recordCounts = countMemoryScopes(snapshot.normalizedRecords);
  const chunkCounts = countMemoryScopes(snapshot.chunks);
  const entityCounts = countMemoryScopes(snapshot.ontologyEntities);
  const relationCounts = countMemoryScopes(snapshot.ontologyRelations);

  return {
    globalResearchMemory: {
      normalizedRecords: recordCounts.global,
      vectorChunks: chunkCounts.global,
      ontologyEntities: entityCounts.global,
      ontologyRelations: relationCounts.global
    },
    projectWorkspace: {
      rawSources: snapshot.sources.length,
      artifacts: snapshot.artifacts.length,
      toolLogs: snapshot.toolRuns.length,
      evidenceLedger: snapshot.evidence.length,
      normalizedRecords: recordCounts.project,
      vectorChunks: chunkCounts.project,
      ontologyEntities: entityCounts.project,
      ontologyRelations: relationCounts.project,
      projectsAndReports: snapshot.finalOutputs.length || (snapshot.report ? 1 : 0),
      errorsAndBlockers: snapshot.stepErrors.length + snapshot.runtimeBlockers.length
    }
  };
}

function countMemoryScopes(items: Array<{ memoryScope?: string }>): { global: number; project: number } {
  let global = 0;
  for (const item of items) {
    if (item.memoryScope === "global") {
      global += 1;
    }
  }
  return { global, project: items.length - global };
}

function renderLoopMarkdown(spec: Record<string, unknown>): string {
  const project = spec.project as Record<string, unknown>;
  const stages = spec.stages as Array<Record<string, string>>;
  const counts = spec.counts as Record<string, number>;
  const memory = spec.persistentResearchMemory as Record<string, Record<string, number>>;
  const globalMemory = memory.globalResearchMemory ?? {};
  const projectWorkspace = memory.projectWorkspace ?? {};
  const lines = [
    `# AetherOps 12-Step Research Loop - ${project.topic}`,
    "",
    "## Current State",
    `- Status: ${project.status}`,
    `- Current step: ${project.currentStep}`,
    `- Project root: ${project.projectRoot}`,
    "",
    "## Flow"
  ];
  for (const stage of stages) {
    lines.push(`- ${stage.index}. ${stage.title} (${stage.step}) - ${stage.state} / ${stage.flowKind}`);
  }
  lines.push(
    "",
    "## Loop Rule",
    "- Step 11 returns to Step 4 when shouldContinue=true.",
    "- Step 11 goes to Step 12 when evidence is sufficient or limits are reached.",
    "",
    "## Counts"
  );
  for (const [key, value] of Object.entries(counts)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push("", "## Persistent Research Memory", "- Global Research Memory");
  for (const [key, value] of Object.entries(globalMemory)) {
    lines.push(`  - ${key}: ${value}`);
  }
  lines.push("- Project Workspace");
  for (const [key, value] of Object.entries(projectWorkspace)) {
    lines.push(`  - ${key}: ${value}`);
  }
  lines.push("");
  return lines.join("\n");
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
  withJsonUpserter(path, (sqlite) => {
    sqlite.upsert(table, id, projectId, createdAt, data);
  });
}

function withJsonUpserter<T>(path: string, write: (sqlite: LazyJsonUpserter) => T): T {
  const sqlite = createLazyJsonUpserter(path);
  try {
    return write(sqlite);
  } finally {
    sqlite.close();
  }
}

function createLazyJsonUpserter(path: string): LazyJsonUpserter {
  let db: DatabaseSync | undefined;
  let upsert: JsonUpserter | undefined;
  return {
    upsert(table, id, projectId, createdAt, data) {
      if (!upsert) {
        db = new DatabaseSync(path);
        upsert = createJsonUpserter(db);
      }
      upsert(table, id, projectId, createdAt, data);
    },
    close() {
      db?.close();
      db = undefined;
      upsert = undefined;
    }
  };
}

type JsonUpserter = (table: string, id: string, projectId: string, createdAt: string, data: unknown) => void;
type LazyJsonUpserter = { upsert: JsonUpserter; close: () => void };

function createJsonUpserter(db: DatabaseSync): JsonUpserter {
  const statements = new Map<string, StatementSync>();
  return (table, id, projectId, createdAt, data) => {
    let statement = statements.get(table);
    if (!statement) {
      statement = db.prepare(
        `insert into ${table} (id, project_id, created_at, data) values (?, ?, ?, ?) on conflict(id) do update set data = excluded.data`
      );
      statements.set(table, statement);
    }
    statement.run(id, projectId, createdAt, JSON.stringify(data));
  };
}

async function writeSourceText(project: ResearchProject, source: ResearchSource): Promise<ResearchSource> {
  const folder = source.kind === "paper" ? "papers" : source.kind === "web" ? "web" : "files";
  const filename = `${sanitizeFilename(source.title)}-${source.id}.json`;
  const rawPath = isExternalSource(source)
    ? safeMainJoin(project.projectRoot, `sources/${folder}/${filename}`)
    : safeJoin(project.projectRoot, `sources/${folder}/${filename}`);
  writeJsonFileSync(rawPath, source);
  return { ...source, rawPath };
}

function isExternalSource(source: ResearchSource): boolean {
  return (source.kind === "web" || source.kind === "paper") && Boolean(source.url || source.doi);
}

function stripExternalRawPayload(source: ResearchSource): ResearchSource {
  if (!Object.prototype.hasOwnProperty.call(source.metadata, "rawText")) return source;
  const metadata = { ...source.metadata };
  delete metadata.rawText;
  return { ...source, metadata };
}

function toolRunIds(toolRuns: ToolRun[]): string[] {
  const ids: string[] = [];
  for (const toolRun of toolRuns) {
    ids.push(toolRun.id);
  }
  return ids;
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
  const candidate = (relativePath.trim() || defaultRelativePath).replace(/^\/+/, "");
  return candidate.startsWith("artifacts/") || candidate.startsWith("reports/")
    ? candidate
    : `artifacts/iteration-${iteration}/${candidate}`;
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
  const labels = new Map<string, string>();
  for (const entity of graph.entities ?? []) {
    labels.set(entity.id, entity.label);
  }
  const lines: string[] = [];
  for (const relation of graph.relations ?? []) {
    lines.push(`<urn:aetherops:${relation.subjectId}> <urn:aetherops:${relation.predicate}> <urn:aetherops:${relation.objectId}> . # ${labels.get(relation.subjectId) ?? relation.subjectId} -> ${labels.get(relation.objectId) ?? relation.objectId}`);
  }
  return lines.join("\n");
}
