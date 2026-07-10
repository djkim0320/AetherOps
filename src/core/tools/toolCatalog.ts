import { ArtifactWriterTool } from "./artifactWriterTool.js";
import { DataAnalysisTool } from "./dataAnalysisTool.js";
import type { ResearchTool } from "./researchToolTypes.js";

export function createDefaultResearchTools(): ResearchTool[] {
  return [new ArtifactWriterTool(), new DataAnalysisTool()];
}
