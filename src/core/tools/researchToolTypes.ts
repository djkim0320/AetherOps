import type { AppSettings, EvidenceItem, OpenCodeRunInput, ResearchArtifact, ResearchSource, ToolRun } from "../shared/types.js";

export interface ResearchToolResult {
  toolRun: ToolRun;
  evidence: EvidenceItem[];
  artifacts: ResearchArtifact[];
  sources: ResearchSource[];
}

export interface ResearchTool {
  name: string;
  run(input: OpenCodeRunInput, settings: AppSettings): Promise<ResearchToolResult>;
}
