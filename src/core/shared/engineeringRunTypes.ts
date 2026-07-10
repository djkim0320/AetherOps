import type { EngineeringProgramRequest } from "./engineeringTypes.js";
import type { EvidenceItem, ResearchArtifact, ToolRun } from "./recordTypes.js";

export interface EngineeringProgramDirectRunInput {
  projectId: string;
  title?: string;
  programRequests: EngineeringProgramRequest[];
}

export interface EngineeringProgramDirectRunResult {
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  toolRun: ToolRun;
  programRuns: unknown[];
  artifacts: ResearchArtifact[];
  evidence: EvidenceItem[];
  reportMarkdown: string;
  savedReportArtifact?: ResearchArtifact;
  error?: string;
}
