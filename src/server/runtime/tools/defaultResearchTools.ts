import { ArtifactWriterTool } from "../../../core/tools/artifactWriterTool.js";
import { DataAnalysisTool } from "../../../core/tools/dataAnalysisTool.js";
import { EngineeringProgramTool } from "../../../core/tools/engineeringProgramTool.js";
import type { ResearchTool } from "../../../core/tools/researchToolTypes.js";
import { runEngineeringProgram } from "../engineering/engineeringProgramRegistry.js";
import { PdfIngestionTool } from "./pdfIngestionTool.js";
import { ResearchMetadataTool } from "./researchMetadataTool.js";
import { WebFetchTool } from "./webFetchTool.js";
import { WebSearchTool } from "./webSearchTool.js";

export function createRuntimeResearchTools(): ResearchTool[] {
  return [
    new WebSearchTool(),
    new WebFetchTool(),
    new ResearchMetadataTool(),
    new EngineeringProgramTool(runEngineeringProgram),
    new PdfIngestionTool(),
    new ArtifactWriterTool(),
    new DataAnalysisTool()
  ];
}
