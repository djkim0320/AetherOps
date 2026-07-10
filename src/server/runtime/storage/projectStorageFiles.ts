import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { ResearchLoopStep } from "../../../core/shared/types.js";
import type { FinalResearchOutput, ResearchProject, ResearchSnapshot, ResearchSource, ResearchDatabase, ToolRun } from "../../../core/shared/types.js";
import { upsertJson } from "./projectJsonDatabase.js";

export function reportKnowledgePaths(project: ResearchProject) {
  return {
    reportPath: safeJoin(project.projectRoot, "reports/final-report.pdf"),
    knowledgePath: safeJoin(project.projectRoot, "knowledge/reusable-knowledge.md")
  };
}

export function finalOutputStagingRoot(project: ResearchProject, output: FinalResearchOutput): string {
  return projectStagingRoot(project, "final", output.id);
}

export function projectStagingRoot(project: ResearchProject, prefix: string, id: string): string {
  const root = safeJoin(project.projectRoot, `.aetherops-${prefix}-staging-${sanitizeFilename(id)}-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

export interface ProjectFileTarget {
  finalPath: string;
  stagedPath: string;
  backupPath: string;
}

export function projectFileTarget(project: ResearchProject, stagingRoot: string, finalPath: string): ProjectFileTarget {
  const relativeFinalPath = relative(normalize(project.projectRoot), finalPath);
  if (relativeFinalPath.startsWith("..") || isAbsolute(relativeFinalPath)) throw new Error(`Project output path escapes project root: ${finalPath}`);
  const stagedPath = join(stagingRoot, "files", relativeFinalPath);
  const backupPath = join(stagingRoot, "backup", relativeFinalPath);
  mkdirSync(dirname(stagedPath), { recursive: true });
  mkdirSync(dirname(backupPath), { recursive: true });
  return { finalPath, stagedPath, backupPath };
}

export function commitFinalOutputFiles(
  database: ResearchDatabase,
  project: ResearchProject,
  output: FinalResearchOutput,
  targets: ProjectFileTarget[],
  saved: FinalResearchOutput
): void {
  commitProjectFiles(targets, () => upsertJson(database.sqlitePath, "final_outputs", output.id, project.id, output.createdAt, saved));
}

export function commitProjectFiles(targets: ProjectFileTarget[], commitMetadata: () => void): void {
  const installed: ProjectFileTarget[] = [];
  const backups: ProjectFileTarget[] = [];
  let metadataCommitted = false;
  try {
    for (const target of targets)
      if (existsSync(target.finalPath)) {
        renameSync(target.finalPath, target.backupPath);
        backups.push(target);
      }
    for (const target of targets) {
      renameSync(target.stagedPath, target.finalPath);
      installed.push(target);
    }
    commitMetadata();
    metadataCommitted = true;
    for (const target of backups) safeRemove(target.backupPath);
  } catch (error) {
    if (!metadataCommitted) {
      for (const target of [...installed].reverse()) safeRemove(target.finalPath);
      for (const target of [...backups].reverse())
        if (existsSync(target.backupPath)) {
          safeRemove(target.finalPath);
          renameSync(target.backupPath, target.finalPath);
        }
    }
    throw error;
  }
}

export function safeRemove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

export function writeProjectManifest(root: string, project: ResearchProject): void {
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

export function writeLoopSpec(root: string, spec: Record<string, unknown>): void {
  writeJsonFileSync(join(root, "aetherops-loop.json"), spec);
  writeMarkdownFileSync(join(root, "aetherops-loop.md"), renderLoopMarkdown(spec));
}

export function writeJsonFileSync(path: string, data: unknown): void {
  writeTextFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeTextFileSync(path: string, content: string, markdown = false): void {
  writeFileSync(path, markdown ? withOptionalMarkdownBom(content) : content, "utf8");
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

export function writeMarkdownFileSync(path: string, markdown: string): void {
  writeTextFileSync(path, markdown, true);
}

export function buildLoopSpec(snapshot: ResearchSnapshot): Record<string, unknown> {
  const project = snapshot.project;
  const visited = new Set(snapshot.iterations.map((iteration) => iteration.step));
  const stages = loopStages.map((stage) => ({
    ...stage,
    state: project.currentStep === stage.step ? "active" : visited.has(stage.step) ? "completed" : "pending"
  }));
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
    exactFlow: loopStages.map((stage) => `${stage.index}. ${stage.step}`),
    stages,
    loopBack: { from: ResearchLoopStep.DecideContinuation, to: ResearchLoopStep.PlanResearch, condition: "shouldContinue=true" },
    persistentResearchMemory: buildPersistentMemorySummary(snapshot),
    counts: snapshotCounts(snapshot),
    latestSpecification: snapshot.specifications.at(-1),
    latestPlan: snapshot.researchPlans.at(-1),
    latestContinuationDecision: snapshot.continuationDecisions.at(-1),
    finalOutput: snapshot.finalOutputs.at(-1),
    recentEvents: snapshot.iterations.slice(-20)
  };
}

function snapshotCounts(snapshot: ResearchSnapshot): Record<string, number> {
  return {
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
  };
}

function buildPersistentMemorySummary(snapshot: ResearchSnapshot): Record<string, unknown> {
  const records = countMemoryScopes(snapshot.normalizedRecords);
  const chunks = countMemoryScopes(snapshot.chunks);
  const entities = countMemoryScopes(snapshot.ontologyEntities);
  const relations = countMemoryScopes(snapshot.ontologyRelations);
  return {
    globalResearchMemory: {
      normalizedRecords: records.global,
      vectorChunks: chunks.global,
      ontologyEntities: entities.global,
      ontologyRelations: relations.global
    },
    projectWorkspace: {
      rawSources: snapshot.sources.length,
      artifacts: snapshot.artifacts.length,
      toolLogs: snapshot.toolRuns.length,
      evidenceLedger: snapshot.evidence.length,
      normalizedRecords: records.project,
      vectorChunks: chunks.project,
      ontologyEntities: entities.project,
      ontologyRelations: relations.project,
      projectsAndReports: snapshot.finalOutputs.length || (snapshot.report ? 1 : 0),
      errorsAndBlockers: snapshot.stepErrors.length + snapshot.runtimeBlockers.length
    }
  };
}

function countMemoryScopes(items: Array<{ memoryScope?: string }>) {
  const global = items.filter((item) => item.memoryScope === "global").length;
  return { global, project: items.length - global };
}

function renderLoopMarkdown(spec: Record<string, unknown>): string {
  const project = spec.project as Record<string, unknown>;
  const stages = spec.stages as Array<Record<string, string>>;
  const counts = spec.counts as Record<string, number>;
  const memory = spec.persistentResearchMemory as Record<string, Record<string, number>>;
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
  for (const stage of stages) lines.push(`- ${stage.index}. ${stage.title} (${stage.step}) - ${stage.state} / ${stage.flowKind}`);
  lines.push(
    "",
    "## Loop Rule",
    "- Step 11 returns to Step 4 when shouldContinue=true.",
    "- Step 11 goes to Step 12 when evidence is sufficient or limits are reached.",
    "",
    "## Counts"
  );
  for (const [key, value] of Object.entries(counts)) lines.push(`- ${key}: ${value}`);
  lines.push("", "## Persistent Research Memory", "- Global Research Memory");
  for (const [key, value] of Object.entries(memory.globalResearchMemory ?? {})) lines.push(`  - ${key}: ${value}`);
  lines.push("- Project Workspace");
  for (const [key, value] of Object.entries(memory.projectWorkspace ?? {})) lines.push(`  - ${key}: ${value}`);
  return `${lines.join("\n")}\n`;
}

const loopStages = Object.values(ResearchLoopStep).map((step, index) => ({
  index: index + 1,
  step,
  title: step,
  flowKind: step === ResearchLoopStep.DecideContinuation ? "Loop Back" : "Research Flow"
}));

export async function writeSourceText(project: ResearchProject, source: ResearchSource): Promise<ResearchSource> {
  const folder = source.kind === "paper" ? "papers" : source.kind === "web" ? "web" : "files";
  const filename = `${sanitizeFilename(source.title)}-${source.id}.json`;
  const rawPath = isExternalSource(source)
    ? safeMainJoin(project.projectRoot, `sources/${folder}/${filename}`)
    : safeJoin(project.projectRoot, `sources/${folder}/${filename}`);
  writeJsonFileSync(rawPath, source);
  return { ...source, rawPath };
}

export function isExternalSource(source: ResearchSource): boolean {
  return (source.kind === "web" || source.kind === "paper") && Boolean(source.url || source.doi);
}

export function stripExternalRawPayload(source: ResearchSource): ResearchSource {
  if (!Object.prototype.hasOwnProperty.call(source.metadata, "rawText")) return source;
  const metadata = { ...source.metadata };
  delete metadata.rawText;
  return { ...source, metadata };
}

export function toolRunIds(toolRuns: ToolRun[]): string[] {
  return toolRuns.map((toolRun) => toolRun.id);
}

function safeMainJoin(projectRoot: string, target: string): string {
  const root = mainFilesRoot(projectRoot);
  const resolved = join(root, normalize(target).replace(/^(\.\.(\/|\\|$))+/, ""));
  assertContained(root, resolved, target, "main research memory");
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function mainFilesRoot(projectRoot: string): string {
  const parent = dirname(normalize(projectRoot));
  return basename(parent).toLowerCase() === "projects" ? join(dirname(parent), "main", "files") : join(parent, "main", "files");
}

export function normalizeArtifactPath(relativePath: string, iteration: number, title: string): string {
  const candidate = (relativePath.trim() || `artifacts/iteration-${iteration}/${sanitizeFilename(title)}.md`).replace(/^\/+/, "");
  return candidate.startsWith("artifacts/") || candidate.startsWith("reports/") ? candidate : `artifacts/iteration-${iteration}/${candidate}`;
}

export function safeJoin(root: string, target: string): string {
  const base = normalize(root);
  const normalizedTarget = normalize(target).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = isAbsolute(normalizedTarget) ? normalizedTarget : join(base, normalizedTarget);
  assertContained(base, resolved, target, "project");
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function assertContained(root: string, resolved: string, target: string, label: string): void {
  const distance = relative(root, resolved);
  if (distance.startsWith("..") || isAbsolute(distance)) throw new Error(`Path escapes ${label} root: ${target}`);
}

function sanitizeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "artifact"
  );
}

export function toNTriples(graphExport: unknown): string {
  const graph = graphExport as {
    entities?: Array<{ id: string; label: string }>;
    relations?: Array<{ subjectId: string; predicate: string; objectId: string }>;
  };
  const labels = new Map((graph.entities ?? []).map((entity) => [entity.id, entity.label]));
  return (graph.relations ?? [])
    .map(
      (relation) =>
        `<urn:aetherops:${relation.subjectId}> <urn:aetherops:${relation.predicate}> <urn:aetherops:${relation.objectId}> . # ${labels.get(relation.subjectId) ?? relation.subjectId} -> ${labels.get(relation.objectId) ?? relation.objectId}`
    )
    .join("\n");
}

export function appendJsonLine(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}
