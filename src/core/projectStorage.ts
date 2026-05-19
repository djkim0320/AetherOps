import { createId, nowIso } from "./ids.js";
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
} from "./types.js";

export interface ProjectStorage {
  ensureResearchDb(project: ResearchProject): Promise<ResearchDatabase>;
  writeArtifacts(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    artifacts: ResearchArtifact[]
  ): Promise<ResearchArtifact[]>;
  writeRunLog(
    project: ResearchProject,
    database: ResearchDatabase,
    iteration: number,
    run: OpenCodeRun,
    toolRuns: ToolRun[]
  ): Promise<ResearchSource | undefined>;
  writeSources(project: ResearchProject, database: ResearchDatabase, sources: ResearchSource[]): Promise<ResearchSource[]>;
  writeChunks(project: ResearchProject, database: ResearchDatabase, chunks: ResearchChunk[]): Promise<void>;
  writeReportFiles(
    project: ResearchProject,
    database: ResearchDatabase,
    report: ResearchReport,
    markdown: string,
    reusableKnowledge: string
  ): Promise<{ reportPath: string; knowledgePath: string }>;
  writeProjectState(snapshot: ResearchSnapshot): Promise<void>;
}

export class NoopProjectStorage implements ProjectStorage {
  async ensureResearchDb(project: ResearchProject): Promise<ResearchDatabase> {
    return {
      id: createId("db"),
      projectId: project.id,
      sqlitePath: `${project.projectRoot}/research.sqlite`,
      vectorPath: `${project.projectRoot}/vector.sqlite`,
      artifactRoot: `${project.projectRoot}/artifacts`,
      sourceRoot: `${project.projectRoot}/sources`,
      logRoot: `${project.projectRoot}/logs`,
      reportRoot: `${project.projectRoot}/reports`,
      knowledgeRoot: `${project.projectRoot}/knowledge`,
      createdAt: nowIso()
    };
  }

  async writeArtifacts(
    _project: ResearchProject,
    _database: ResearchDatabase,
    _iteration: number,
    artifacts: ResearchArtifact[]
  ): Promise<ResearchArtifact[]> {
    return artifacts;
  }

  async writeRunLog(
    project: ResearchProject,
    _database: ResearchDatabase,
    iteration: number,
    run: OpenCodeRun
  ): Promise<ResearchSource> {
    const createdAt = nowIso();
    return {
      id: `source_${run.id}`,
      projectId: project.id,
      kind: "log",
      title: `Iteration ${iteration} execution log`,
      retrievedAt: createdAt,
      metadata: { runId: run.id, iteration },
      createdAt
    };
  }

  async writeSources(
    _project: ResearchProject,
    _database: ResearchDatabase,
    sources: ResearchSource[]
  ): Promise<ResearchSource[]> {
    return sources;
  }

  async writeChunks(): Promise<void> {
    return;
  }

  async writeReportFiles(): Promise<{ reportPath: string; knowledgePath: string }> {
    return { reportPath: "", knowledgePath: "" };
  }

  async writeProjectState(): Promise<void> {
    return;
  }
}
