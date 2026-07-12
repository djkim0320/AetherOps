import { mkdirSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { createId, nowIso } from "../../../core/shared/ids.js";
import { dedupeSourcesByIdUrlDoi } from "../../../core/evidence/sourceDedupe.js";
import type { ProjectStorage } from "../../../core/storage/projectStorage.js";
import type {
  FinalResearchOutput,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  LegacyAgentRun,
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
import { writePdfReport } from "../output/pdfReportRenderer.js";
import { createLazyJsonUpserter, migrateOntologyDb, migrateResearchDb, migrateVectorDb, upsertJson, withJsonUpserter } from "./projectJsonDatabase.js";
import {
  appendJsonLine,
  buildLoopSpec,
  commitFinalOutputFiles,
  commitProjectFiles,
  finalOutputStagingRoot,
  isExternalSource,
  normalizeArtifactPath,
  projectFileTarget,
  projectStagingRoot,
  reportKnowledgePaths,
  safeJoin,
  safeRemove,
  stripExternalRawPayload,
  toNTriples,
  toolRunIds,
  writeJsonFileSync,
  writeLoopSpec,
  writeMarkdownFileSync,
  writeProjectManifest,
  writeSourceText,
  writeTextFileSync
} from "./projectStorageFiles.js";

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
    ])
      mkdirSync(directory, { recursive: true });
    migrateResearchDb(paths.sqlitePath);
    migrateVectorDb(paths.vectorPath);
    migrateOntologyDb(paths.ontologyPath);
    writeProjectManifest(root, project);
    writeJsonFileSync(paths.statePath, { project, updatedAt: nowIso() });
    return { id: createId("db"), projectId: project.id, ...paths, createdAt: nowIso() };
  }

  async writeArtifacts(project: ResearchProject, database: ResearchDatabase, iteration: number, artifacts: ResearchArtifact[]): Promise<ResearchArtifact[]> {
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
    run: LegacyAgentRun,
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
      for (const toolRun of toolRuns) sqlite.upsert("tool_runs", toolRun.id, project.id, toolRun.completedAt, toolRun);
    });
    return source;
  }

  async writeSources(project: ResearchProject, database: ResearchDatabase, sources: ResearchSource[]): Promise<ResearchSource[]> {
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
      for (const chunk of chunks) sqlite.upsert("chunks", chunk.id, project.id, chunk.createdAt, chunk);
    });
  }

  async writeOntologyGraph(
    project: ResearchProject,
    database: ResearchDatabase,
    graph: { entities: OntologyEntity[]; relations: OntologyRelation[]; constraints: OntologyConstraint[]; exportedAt: string }
  ): Promise<{ ontologyExportPath: string; ontologyNtPath: string }> {
    const ontologyExportPath = safeJoin(project.projectRoot, "ontology/project-graph.json");
    const ontologyNtPath = safeJoin(project.projectRoot, "ontology/project-graph.nt");
    writeJsonFileSync(ontologyExportPath, graph);
    writeFileSync(ontologyNtPath, toNTriples(graph), "utf8");
    withJsonUpserter(database.ontologyPath ?? safeJoin(project.projectRoot, "ontology.sqlite"), (sqlite) => {
      for (const entity of graph.entities) sqlite.upsert("ontology_entities", entity.id, project.id, entity.createdAt, entity);
      for (const relation of graph.relations) sqlite.upsert("ontology_relations", relation.id, project.id, relation.createdAt, relation);
      for (const constraint of graph.constraints) sqlite.upsert("ontology_constraints", constraint.id, project.id, constraint.createdAt, constraint);
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
      report: projectFileTarget(project, stagingRoot, reportPath),
      knowledge: projectFileTarget(project, stagingRoot, knowledgePath),
      citations: projectFileTarget(project, stagingRoot, citationsPath),
      verification: projectFileTarget(project, stagingRoot, verificationPath),
      ontologyJson: projectFileTarget(project, stagingRoot, ontologyExportPath),
      ontologyNt: projectFileTarget(project, stagingRoot, ontologyNtPath),
      artifactPackage: projectFileTarget(project, stagingRoot, artifactPackagePath)
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

  async writeRunAuditFiles(project: ResearchProject, database: ResearchDatabase, output: RunAuditOutput): Promise<{ reportPath: string; jsonPath: string }> {
    const reportPath = safeJoin(project.projectRoot, "reports/run-audit.md");
    const jsonPath = safeJoin(project.projectRoot, "exports/run-audit.json");
    const saved = { ...output, reportPath, jsonPath };
    const stagingRoot = projectStagingRoot(project, "run-audit", output.id);
    const targets = { report: projectFileTarget(project, stagingRoot, reportPath), json: projectFileTarget(project, stagingRoot, jsonPath) };
    try {
      writeMarkdownFileSync(targets.report.stagedPath, output.markdownReport);
      writeJsonFileSync(targets.json.stagedPath, saved);
      commitProjectFiles(Object.values(targets), () => upsertJson(database.sqlitePath, "run_audit_outputs", output.id, project.id, output.createdAt, saved));
      return { reportPath, jsonPath };
    } finally {
      safeRemove(stagingRoot);
    }
  }

  async writeRuntimeBlocker(project: ResearchProject, blocker: RuntimeBlocker): Promise<void> {
    appendJsonLine(safeJoin(project.projectRoot, "errors/runtime-blockers.jsonl"), blocker);
  }
  async writeStepError(project: ResearchProject, error: StepError): Promise<void> {
    appendJsonLine(safeJoin(project.projectRoot, "errors/step-errors.jsonl"), error);
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
