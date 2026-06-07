import type {
  ContinuationDecision,
  FinalResearchOutput,
  BenchmarkPlan,
  ProjectContextSnapshot,
  ResearchInput,
  ResearchPlan,
  ResearchSpecification,
  RunAuditOutput,
  ValidationResult
} from "../shared/types.js";

export interface ProjectWorkspaceStore {
  saveResearchInput(input: ResearchInput): Promise<void>;
  saveResearchSpecification(specification: ResearchSpecification): Promise<void>;
  saveResearchPlan(plan: ResearchPlan): Promise<void>;
  linkGlobalRecords(projectId: string, recordIds: string[]): Promise<void>;
  linkGlobalChunks(projectId: string, chunkIds: string[]): Promise<void>;
  linkGlobalGraph(projectId: string, entityIds: string[], relationIds: string[]): Promise<void>;
  saveProjectContextSnapshot(context: ProjectContextSnapshot): Promise<void>;
  saveValidationResults(results: ValidationResult[]): Promise<void>;
  saveContinuationDecision(decision: ContinuationDecision): Promise<void>;
  saveFinalResearchOutput(output: FinalResearchOutput): Promise<void>;
  saveRunAuditOutput(output: RunAuditOutput): Promise<void>;
  saveBenchmarkPlan(plan: BenchmarkPlan): Promise<void>;
}
