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
  validateReceiptIdentityAndHashes(receipt);
  validateReceiptMetadata(receipt);
  validateConvergenceEvidence(receipt.convergenceEvidence);
  validateReceiptBindings(receipt);
  if (receipt.exitStatus === "completed") validateCompletedReceipt(receipt);
  else if (receipt.outputArtifactIds.length) throw new Error("Non-completed simulation output artifacts must remain quarantined.");
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

function validateReceiptIdentityAndHashes(receipt: SimulationRunReceipt): void {
  if (![receipt.runId, receipt.analysisCaseId, receipt.toolId, receipt.toolVersion].every((value) => value.trim())) {
    throw new Error("Simulation run identity is required.");
  }
  if (!receipt.inputArtifactHashes.length || !isUnique(receipt.inputArtifactHashes)) {
    throw new Error("Simulation input hashes must be non-empty and unique.");
  }
  const requiredHashes = [receipt.environmentHash, receipt.configurationHash, ...receipt.inputArtifactHashes];
  const optionalHashes = [receipt.executableHash, receipt.geometryHash, receipt.meshHash].filter((value): value is string => value !== undefined);
  if ([...requiredHashes, ...optionalHashes].some((hash) => !isSha(hash))) {
    throw new Error("Simulation environment, executable, configuration, geometry, mesh and input hashes must be SHA-256.");
  }
}

function validateReceiptMetadata(receipt: SimulationRunReceipt): void {
  if (!Number.isFinite(Date.parse(receipt.startTime)) || !Number.isSafeInteger(receipt.durationMs) || receipt.durationMs < 0) {
    throw new Error("Simulation timing metadata is invalid.");
  }
  if (receipt.randomSeed !== undefined && (!Number.isSafeInteger(receipt.randomSeed) || receipt.randomSeed < 0)) {
    throw new Error("Simulation random seed must be a non-negative safe integer.");
  }
  const hardware = receipt.hardwareMetadata;
  if (hardware && (!hardware.architecture.trim() || !Number.isSafeInteger(hardware.logicalCores) || hardware.logicalCores < 1)) {
    throw new Error("Simulation hardware metadata is invalid.");
  }
  validateDiagnostics(receipt.warningMessages, "warning");
  validateDiagnostics(receipt.errorMessages, "error");
}

function validateConvergenceEvidence(evidence: readonly ConvergenceEvidence[]): void {
  for (const item of evidence) {
    const numericValues = [item.initialValue, item.finalValue, item.tolerance];
    if (!item.metric.trim() || numericValues.some((value) => !Number.isFinite(value)) || item.tolerance <= 0) {
      throw new Error("Simulation convergence evidence must have a metric, finite values and a positive tolerance.");
    }
    if (item.historyArtifactId !== undefined && !item.historyArtifactId.trim()) {
      throw new Error("Simulation convergence history artifact id is invalid.");
    }
  }
}

function validateReceiptBindings(receipt: SimulationRunReceipt): void {
  if (!isNonEmptyUnique(receipt.outputArtifactIds)) throw new Error("Simulation output artifacts must be non-empty and unique when present.");
  if (new Set(receipt.postconditionResults.map((result) => result.id)).size !== receipt.postconditionResults.length) {
    throw new Error("Simulation postcondition identities must be unique.");
  }
  for (const result of receipt.postconditionResults) {
    if (!result.id.trim() || !result.detail.trim()) throw new Error("Simulation postcondition identity and detail are required.");
  }
  const assessment = receipt.modelUseAssessment;
  if (![assessment.modelCardId, assessment.modelVersion, assessment.proposedUse, assessment.configurationBaselineId].every((value) => value.trim())) {
    throw new Error("Simulation model-use assessment identity is incomplete.");
  }
}

function validateCompletedReceipt(receipt: SimulationRunReceipt): void {
  if (!receipt.outputArtifactIds.length) throw new Error("Completed simulation requires output artifacts.");
  if (!receipt.postconditionResults.length || receipt.postconditionResults.some((item) => !item.passed)) {
    throw new Error("Completed simulation requires passing postconditions.");
  }
  if (!receipt.convergenceEvidence.length || receipt.convergenceEvidence.some((item) => !item.converged)) {
    throw new Error("Non-converged simulation cannot be completed.");
  }
  if (receipt.errorMessages.length) throw new Error("Completed simulation cannot contain error diagnostics.");
  if (receipt.modelUseAssessment.status !== "accepted_use" && receipt.modelUseAssessment.status !== "accepted_with_limits") {
    throw new Error("Outside-domain model result cannot be promoted as completed.");
  }
}

function validateDiagnostics(entries: readonly { code: string; message: string }[], kind: string): void {
  if (entries.some((entry) => !entry.code.trim() || !entry.message.trim())) throw new Error(`Simulation ${kind} diagnostics must include code and message.`);
}

function isNonEmptyUnique(values: readonly string[]): boolean {
  return values.every((value) => value.trim()) && isUnique(values);
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}
