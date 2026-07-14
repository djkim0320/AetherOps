import type { AerospaceDiscipline, ModelUseAssessment } from "./modelCard.js";

export interface AnalysisCase {
  id: string;
  studyContractId: string;
  configurationBaselineId: string;
  objective: string;
  discipline: AerospaceDiscipline;
  modelCardId: string;
  flightConditionId?: string;
  loadCaseId?: string;
  missionSegmentId?: string;
  inputsSnapshotId: string;
  assumptions: readonly string[];
  expectedOutputs: readonly string[];
  acceptanceCriteria: readonly { id: string; statement: string }[];
  status: "draft" | "ready" | "running" | "completed" | "failed" | "blocked" | "outside_domain" | "not_verified";
}

export interface ConvergenceEvidence {
  metric: string;
  initialValue: number;
  finalValue: number;
  tolerance: number;
  converged: boolean;
  historyArtifactId?: string;
  evidenceKind: "iterative" | "mesh" | "time_step" | "conservation" | "reference_reproduction";
}

export interface SimulationRunReceipt {
  runId: string;
  analysisCaseId: string;
  toolId: string;
  toolVersion: string;
  executableHash?: string;
  environmentHash: string;
  inputArtifactHashes: readonly string[];
  configurationHash: string;
  geometryHash?: string;
  meshHash?: string;
  randomSeed?: number;
  hardwareMetadata?: { architecture: string; logicalCores: number; accelerator?: string };
  startTime: string;
  durationMs: number;
  exitStatus: "completed" | "failed" | "blocked" | "cancelled";
  convergenceEvidence: readonly ConvergenceEvidence[];
  warningMessages: readonly { code: string; message: string }[];
  errorMessages: readonly { code: string; message: string }[];
  outputArtifactIds: readonly string[];
  postconditionResults: readonly { id: string; passed: boolean; detail: string }[];
  modelUseAssessment: ModelUseAssessment;
  uncertaintyBudgetId?: string;
  reproducibilityStatus: "reproduced" | "reproducible_not_rerun" | "environment_missing" | "non_deterministic" | "failed";
}

export interface ReproducibilityManifest {
  analysisCaseId: string;
  simulationRunId: string;
  inputHashes: readonly string[];
  outputIds: readonly string[];
  environmentHash: string;
  configurationHash: string;
  tool: string;
  convergenceReceiptCount: number;
  postconditionReceiptCount: number;
}

export function validateAnalysisCase(value: AnalysisCase): void {
  if (!value.id || !value.studyContractId || !value.configurationBaselineId || !value.objective.trim() || !value.modelCardId || !value.inputsSnapshotId) {
    throw new Error("Analysis case identity, baseline, objective, model and input snapshot are required.");
  }
  if (!value.expectedOutputs.length || !value.acceptanceCriteria.length) throw new Error("Analysis case outputs and acceptance criteria are required.");
}

export function validateSimulationRunReceipt(receipt: SimulationRunReceipt): ReproducibilityManifest {
  if (!receipt.runId || !receipt.analysisCaseId || !receipt.toolId || !receipt.toolVersion) throw new Error("Simulation run identity is required.");
  if (!isSha(receipt.environmentHash) || !isSha(receipt.configurationHash) || receipt.inputArtifactHashes.some((hash) => !isSha(hash))) {
    throw new Error("Simulation environment, configuration and input hashes must be SHA-256.");
  }
  if (!Number.isFinite(Date.parse(receipt.startTime)) || !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) {
    throw new Error("Simulation timing metadata is invalid.");
  }
  if (receipt.exitStatus === "completed") {
    if (!receipt.outputArtifactIds.length) throw new Error("Completed simulation requires output artifacts.");
    if (!receipt.postconditionResults.length || receipt.postconditionResults.some((item) => !item.passed))
      throw new Error("Completed simulation requires passing postconditions.");
    if (!receipt.convergenceEvidence.length || receipt.convergenceEvidence.some((item) => !item.converged))
      throw new Error("Non-converged simulation cannot be completed.");
    if (receipt.modelUseAssessment.status !== "accepted_use" && receipt.modelUseAssessment.status !== "accepted_with_limits") {
      throw new Error("Outside-domain model result cannot be promoted as completed.");
    }
  }
  if (receipt.reproducibilityStatus === "reproduced" && receipt.exitStatus !== "completed") throw new Error("Only a completed run can be marked reproduced.");
  return Object.freeze({
    analysisCaseId: receipt.analysisCaseId,
    simulationRunId: receipt.runId,
    inputHashes: Object.freeze([...receipt.inputArtifactHashes]),
    outputIds: Object.freeze([...receipt.outputArtifactIds]),
    environmentHash: receipt.environmentHash,
    configurationHash: receipt.configurationHash,
    tool: `${receipt.toolId}@${receipt.toolVersion}`,
    convergenceReceiptCount: receipt.convergenceEvidence.length,
    postconditionReceiptCount: receipt.postconditionResults.length
  });
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
