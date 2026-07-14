import { getToolDescriptor } from "../../src/core/tools/toolDescriptors.js";
import { plannerToolInputContract } from "../../src/core/planning/plannerContextPack.js";
import type { PlannerContextCompilationInput } from "../../src/core/tools/researchToolTypes.js";
import { ResearchLoopStep, type ResearchSnapshot, type ResearchSpecification } from "../../src/core/shared/types.js";
import type { StorageCapabilitySet, StorageJobToolPolicy } from "../../src/server/runtime/storage/v2/types.js";
import { STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT, type ContextProviderIdentity } from "../../src/core/context/public.js";

export const M1_PROJECT_ID = "project-m1-long-horizon";
export const M1_TRANSCRIPT_SENTINEL = "M1_TRANSCRIPT_SECRET_SENTINEL";
export const M1_PROVIDER_SECRET = "M1_PROVIDER_SECRET_SENTINEL";
export const M1_CREATED_AT = "2026-07-14T00:00:00.000Z";

export const M1_CAPABILITIES: StorageCapabilitySet = Object.freeze({ agent: true, engineering: false, search: false });
export const M1_TOOL_POLICY: StorageJobToolPolicy = Object.freeze({ allowCodexCli: false, sourceAccess: { mode: "offline" } });

export function m1PlannerInput(
  snapshot: ResearchSnapshot,
  provider: ContextProviderIdentity = {
    providerId: "deterministic-m1",
    modelId: "offline-m1",
    capabilityReceipt: STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT
  }
): PlannerContextCompilationInput {
  const descriptor = getToolDescriptor("DataAnalysisTool");
  if (!descriptor) throw new Error("DataAnalysisTool descriptor is unavailable for the M1 fixture.");
  return {
    snapshot,
    specification: m1Specification(),
    iteration: 1,
    provider,
    tools: [
      {
        name: descriptor.name,
        version: descriptor.version,
        summary: descriptor.description,
        inputContract: plannerToolInputContract(descriptor.name),
        requiredCapabilities: [...descriptor.requiredCapabilities],
        sideEffects: [...descriptor.sideEffects]
      }
    ],
    runtimeToolDiagnostics: {
      executableTools: [descriptor.name],
      researchMetadata: {
        provider: "openalex",
        ready: false,
        maxResults: 5,
        requiredFields: [],
        optionalFields: [],
        description: "External metadata is not required by this offline M1 test."
      },
      engineeringPrograms: [],
      engineeringArtifactCandidates: [],
      engineeringProgramRequestTemplates: [],
      blockers: [],
      generatedAt: M1_CREATED_AT
    }
  };
}

export function m1Snapshot(withTranscript: boolean, allowSearch = false): ResearchSnapshot {
  return {
    project: {
      id: M1_PROJECT_ID,
      goal: "Resume a durable provider-neutral research run from receipts only.",
      topic: "M1 long-horizon durability",
      scope: "Local SQLite and StorageWorker state only.",
      budget: "One bounded offline integration run.",
      autonomyPolicy: {
        toolApproval: "automatic",
        allowAgent: true,
        allowExternalSearch: allowSearch,
        allowCodeExecution: false
      },
      createdAt: M1_CREATED_AT,
      updatedAt: allowSearch ? new Date(Date.parse(M1_CREATED_AT) + 1_000).toISOString() : M1_CREATED_AT,
      currentStep: ResearchLoopStep.PlanResearch,
      status: "running",
      projectRoot: "m1-long-horizon"
    },
    sessions: withTranscript
      ? [{ id: "session-m1", projectId: M1_PROJECT_ID, title: "Ephemeral transcript", focus: M1_TRANSCRIPT_SENTINEL, createdAt: M1_CREATED_AT }]
      : [],
    researchInputs: [
      {
        id: "input-m1",
        projectId: M1_PROJECT_ID,
        researchQuestion: "Can the run resume without transcript replay?",
        initialHypotheses: ["Receipt-bound state is sufficient."],
        constraints: ["No external network."],
        expectedOutputs: ["A durable context receipt."],
        createdAt: M1_CREATED_AT
      }
    ],
    questions: [],
    hypotheses: [],
    evidence: [
      {
        id: "evidence-m1-redaction",
        projectId: M1_PROJECT_ID,
        category: "experiment_log",
        title: "Redaction boundary",
        summary: `Authorization: Bearer ${M1_PROVIDER_SECRET}`,
        keywords: [],
        linkedHypothesisIds: [],
        reliabilityScore: 1,
        relevanceScore: 1,
        metadata: { verificationReceiptId: "verification-m1-redaction" },
        createdAt: M1_CREATED_AT
      }
    ],
    artifacts: [],
    sources: [],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [],
    specifications: [m1Specification()],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [
      {
        id: "validation-m1-redaction",
        projectId: M1_PROJECT_ID,
        iteration: 1,
        status: "inconclusive",
        confidence: 0,
        supportingEvidenceIds: ["evidence-m1-redaction"],
        contradictingEvidenceIds: [],
        relatedEntityIds: [],
        relatedRelationIds: [],
        reasoningSummary: "The redaction fixture is not research evidence.",
        limitations: ["Redaction-only fixture."],
        evidenceGaps: [],
        createdAt: M1_CREATED_AT
      }
    ],
    continuationDecisions: [],
    finalOutputs: [],
    runAuditOutputs: [],
    benchmarkPlans: [],
    runtimeBlockers: [],
    stepErrors: [],
    legacyAgentRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}

export function m1Specification(): ResearchSpecification {
  return {
    id: "specification-m1",
    projectId: M1_PROJECT_ID,
    sourceResearchInputId: "input-m1",
    researchQuestions: ["Can receipt-bound state resume without a transcript?"],
    initialHypotheses: ["Yes."],
    refinedHypotheses: ["Immutable revisions and ContextPack receipts are sufficient."],
    scope: "One offline durable run.",
    assumptions: [],
    constraints: ["No network access.", "No synthetic completion."],
    successCriteria: ["Resume reconstructs a deterministic provider input."],
    requiredEvidenceTypes: ["Storage readback receipt"],
    competencyQuestions: [],
    evaluationMetrics: ["Canonical hash equality"],
    createdAt: M1_CREATED_AT
  };
}
