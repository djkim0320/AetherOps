import type { BaselineChangeImpact } from "./configurationBaseline.js";

export interface RemainingEngineeringBudget {
  toolCalls?: number;
  cpuSeconds?: number;
  memoryBytes?: number;
  diskBytes?: number;
  wallClockMs?: number;
  externalCost?: number;
}

/**
 * Deterministic aerospace-domain projection. SQLite RunStateRevision remains the
 * persistence authority; this value must be committed only through that canonical
 * reducer/worker boundary when storage integration is introduced.
 */
export interface EngineeringRunState {
  runId: string;
  projectId: string;
  revision: number;
  studyContractId: string;
  studyContractRevision: number;
  configurationBaselineId: string;
  currentPhase: string;
  requirementIds: readonly string[];
  claimIds: readonly string[];
  evidenceIds: readonly string[];
  equationIds: readonly string[];
  modelCardIds: readonly string[];
  datasetCardIds: readonly string[];
  analysisCaseIds: readonly string[];
  simulationRunIds: readonly string[];
  decisionRecordIds: readonly string[];
  riskIds: readonly string[];
  taskGraph: { nodeIds: readonly string[]; completedNodeIds: readonly string[]; activeNodeId?: string };
  openQuestions: readonly { id: string; question: string; safetyRelevant: boolean }[];
  assumptions: readonly { id: string; statement: string; approvalStatus: "candidate" | "approved" | "rejected" }[];
  unresolvedContradictions: readonly string[];
  staleArtifactIds: readonly string[];
  invalidationReasons: readonly { artifactId: string; reason: string }[];
  budgets: RemainingEngineeringBudget;
  nextActions: readonly { id: string; description: string; requiresHumanApproval: boolean }[];
}

export type EngineeringRunEvent =
  | { type: "phase_advanced"; expectedRevision: number; phase: string }
  | { type: "references_added"; expectedRevision: number; category: ReferenceCategory; ids: readonly string[] }
  | { type: "question_resolved"; expectedRevision: number; questionId: string; assumption?: EngineeringRunState["assumptions"][number] }
  | { type: "budget_consumed"; expectedRevision: number; consumed: RemainingEngineeringBudget }
  | { type: "baseline_changed"; expectedRevision: number; nextBaselineId: string; impact: BaselineChangeImpact }
  | { type: "task_progressed"; expectedRevision: number; completedNodeId: string; nextNodeId?: string };

type ReferenceCategory =
  | "requirementIds"
  | "claimIds"
  | "evidenceIds"
  | "equationIds"
  | "modelCardIds"
  | "datasetCardIds"
  | "analysisCaseIds"
  | "simulationRunIds"
  | "decisionRecordIds"
  | "riskIds";

export function createEngineeringRunState(input: Omit<EngineeringRunState, "revision" | "staleArtifactIds" | "invalidationReasons">): EngineeringRunState {
  validateIdentifier(input.runId, "Run");
  validateIdentifier(input.projectId, "Project");
  validateIdentifier(input.studyContractId, "Study contract");
  validateIdentifier(input.configurationBaselineId, "Configuration baseline");
  if (!Number.isSafeInteger(input.studyContractRevision) || input.studyContractRevision < 1) throw new Error("Study contract revision is invalid.");
  return freezeState({ ...input, revision: 0, staleArtifactIds: [], invalidationReasons: [] });
}

export function reduceEngineeringRunState(previous: EngineeringRunState, event: EngineeringRunEvent): EngineeringRunState {
  if (event.expectedRevision !== previous.revision) {
    throw new Error(`Engineering run revision conflict: expected ${event.expectedRevision}, current ${previous.revision}.`);
  }
  let next: EngineeringRunState;
  switch (event.type) {
    case "phase_advanced":
      next = { ...previous, revision: previous.revision + 1, currentPhase: required(event.phase, "Engineering phase") };
      break;
    case "references_added":
      next = { ...previous, revision: previous.revision + 1, [event.category]: unique([...(previous[event.category] as readonly string[]), ...event.ids]) };
      break;
    case "question_resolved": {
      if (!previous.openQuestions.some((item) => item.id === event.questionId))
        throw new Error(`Open engineering question does not exist: ${event.questionId}.`);
      next = {
        ...previous,
        revision: previous.revision + 1,
        openQuestions: previous.openQuestions.filter((item) => item.id !== event.questionId),
        assumptions: event.assumption ? uniqueObjects([...previous.assumptions, event.assumption]) : previous.assumptions
      };
      break;
    }
    case "budget_consumed":
      next = { ...previous, revision: previous.revision + 1, budgets: consumeBudget(previous.budgets, event.consumed) };
      break;
    case "baseline_changed":
      if (event.nextBaselineId === previous.configurationBaselineId) throw new Error("Baseline change requires a new baseline ID.");
      next = {
        ...previous,
        revision: previous.revision + 1,
        configurationBaselineId: event.nextBaselineId,
        staleArtifactIds: unique([...previous.staleArtifactIds, ...event.impact.staleArtifactIds]),
        invalidationReasons: Object.freeze([
          ...previous.invalidationReasons,
          ...event.impact.reasons.map((item) => Object.freeze({ artifactId: item.artifactId, reason: item.message }))
        ])
      };
      break;
    case "task_progressed": {
      if (!previous.taskGraph.nodeIds.includes(event.completedNodeId)) throw new Error(`Task node is not in the engineering graph: ${event.completedNodeId}.`);
      if (event.nextNodeId && !previous.taskGraph.nodeIds.includes(event.nextNodeId))
        throw new Error(`Next task node is not in the engineering graph: ${event.nextNodeId}.`);
      next = {
        ...previous,
        revision: previous.revision + 1,
        taskGraph: {
          ...previous.taskGraph,
          completedNodeIds: unique([...previous.taskGraph.completedNodeIds, event.completedNodeId]),
          ...(event.nextNodeId ? { activeNodeId: event.nextNodeId } : { activeNodeId: undefined })
        }
      };
      break;
    }
  }
  return freezeState(next);
}

export function assertArtifactCurrent(state: EngineeringRunState, artifactId: string): void {
  if (state.staleArtifactIds.includes(artifactId)) throw new Error(`Engineering artifact is stale for the current configuration baseline: ${artifactId}.`);
}

function consumeBudget(current: RemainingEngineeringBudget, consumed: RemainingEngineeringBudget): RemainingEngineeringBudget {
  const next: Record<string, number> = {};
  for (const key of ["toolCalls", "cpuSeconds", "memoryBytes", "diskBytes", "wallClockMs", "externalCost"] as const) {
    const used = consumed[key] ?? 0;
    if (!Number.isFinite(used) || used < 0) throw new Error(`Consumed budget ${key} must be finite and nonnegative.`);
    if (current[key] !== undefined) {
      const remaining = (current[key] as number) - used;
      if (remaining < 0) throw new Error(`Engineering budget exceeded: ${key}.`);
      next[key] = remaining;
    }
  }
  return Object.freeze(next);
}

function freezeState(state: EngineeringRunState): EngineeringRunState {
  return Object.freeze({
    ...state,
    requirementIds: unique(state.requirementIds),
    claimIds: unique(state.claimIds),
    evidenceIds: unique(state.evidenceIds),
    equationIds: unique(state.equationIds),
    modelCardIds: unique(state.modelCardIds),
    datasetCardIds: unique(state.datasetCardIds),
    analysisCaseIds: unique(state.analysisCaseIds),
    simulationRunIds: unique(state.simulationRunIds),
    decisionRecordIds: unique(state.decisionRecordIds),
    riskIds: unique(state.riskIds),
    staleArtifactIds: unique(state.staleArtifactIds),
    openQuestions: Object.freeze(state.openQuestions.map((item) => Object.freeze({ ...item }))),
    assumptions: Object.freeze(state.assumptions.map((item) => Object.freeze({ ...item }))),
    invalidationReasons: Object.freeze(state.invalidationReasons.map((item) => Object.freeze({ ...item }))),
    nextActions: Object.freeze(state.nextActions.map((item) => Object.freeze({ ...item }))),
    taskGraph: Object.freeze({ ...state.taskGraph, nodeIds: unique(state.taskGraph.nodeIds), completedNodeIds: unique(state.taskGraph.completedNodeIds) }),
    budgets: Object.freeze({ ...state.budgets })
  });
}

function unique(values: readonly string[]): readonly string[] {
  for (const value of values) validateIdentifier(value, "Reference");
  return Object.freeze([...new Set(values)]);
}

function uniqueObjects<T extends { id: string }>(values: readonly T[]): readonly T[] {
  if (new Set(values.map((item) => item.id)).size !== values.length) throw new Error("Engineering object IDs must be unique.");
  return Object.freeze(values.map((item) => Object.freeze({ ...item })));
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value)) throw new Error(`${label} identifier is invalid.`);
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
