export const RESEARCH_STORE_METHODS = [
  "saveProject",
  "updateProject",
  "listProjects",
  "getProject",
  "saveSessions",
  "deleteSession",
  "saveDatabase",
  "saveResearchInput",
  "saveQuestions",
  "saveHypotheses",
  "saveEvidence",
  "saveArtifacts",
  "saveSources",
  "saveChunks",
  "saveToolRuns",
  "saveAgentPlan",
  "saveResearchSpecification",
  "saveResearchPlan",
  "saveNormalizedRecords",
  "saveOntologyEntities",
  "saveOntologyRelations",
  "saveOntologyConstraints",
  "saveProjectContextSnapshot",
  "saveHybridContext",
  "saveValidationResults",
  "saveContinuationDecision",
  "saveFinalResearchOutput",
  "saveRunAuditOutput",
  "saveBenchmarkPlan",
  "saveGlobalMemoryItems",
  "saveRuntimeBlocker",
  "saveStepError",
  "saveOpenCodeRun",
  "saveRagContext",
  "saveResult",
  "saveIteration",
  "saveReport",
  "getSnapshot",
  "searchGlobalRecords",
  "searchGlobalChunks",
  "searchGlobalGraph"
] as const;

export const PROJECT_STORAGE_METHODS = [
  "ensureResearchDb",
  "writeArtifacts",
  "writeRunLog",
  "writeSources",
  "writeChunks",
  "writeOntologyGraph",
  "writeFinalOutputFiles",
  "writeRunAuditFiles",
  "writeRuntimeBlocker",
  "writeStepError",
  "writeProjectState"
] as const;
export const SETTINGS_STORE_METHODS = ["getSettings", "getRuntimeSettings", "saveSettings"] as const;

export type LegacyStorageTarget = "researchStore" | "projectStorage" | "settingsStore";
export interface LegacyStorageRequest {
  id: string;
  target: LegacyStorageTarget;
  method: string;
  args: unknown[];
}
export type LegacyStorageResponse =
  { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { name: string; message: string; stack?: string } };
