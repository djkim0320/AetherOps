import type {
  OpenCodeRun,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  ResearchArtifact,
  ResearchChunk,
  ResearchDatabase,
  FinalResearchOutput,
  ResearchProject,
  ResearchReport,
  ResearchSnapshot,
  ResearchSource,
  RunAuditOutput,
  RuntimeBlocker,
  StepError,
  ToolRun
} from "../shared/types.js";

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
  writeOntologyGraph(
    project: ResearchProject,
    database: ResearchDatabase,
    graph: {
      entities: OntologyEntity[];
      relations: OntologyRelation[];
      constraints: OntologyConstraint[];
      exportedAt: string;
    }
  ): Promise<{ ontologyExportPath: string; ontologyNtPath: string }>;
  writeReportFiles(
    project: ResearchProject,
    database: ResearchDatabase,
    report: ResearchReport,
    markdown: string,
    reusableKnowledge: string
  ): Promise<{ reportPath: string; knowledgePath: string }>;
  writeFinalOutputFiles?(
    project: ResearchProject,
    database: ResearchDatabase,
    output: FinalResearchOutput,
    graphExport: unknown,
    artifactPackage: unknown,
    evidenceCitations: unknown,
    hypothesisVerification: unknown
  ): Promise<{ reportPath: string; knowledgePath: string; ontologyExportPath: string; artifactPackagePath: string }>;
  writeRunAuditFiles?(
    project: ResearchProject,
    database: ResearchDatabase,
    output: RunAuditOutput
  ): Promise<{ reportPath: string; jsonPath: string }>;
  writeRuntimeBlocker?(project: ResearchProject, blocker: RuntimeBlocker): Promise<void>;
  writeStepError?(project: ResearchProject, error: StepError): Promise<void>;
  writeProjectState(snapshot: ResearchSnapshot): Promise<void>;
}
