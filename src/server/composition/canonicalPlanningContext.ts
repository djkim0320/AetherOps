import {
  ContextCompiler,
  createContextPackPersistenceReceipt,
  type ContextPack,
  type ContextPackPersistenceReceipt,
  type ContextTextCandidate
} from "../../core/context/public.js";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import type { RunStateRevision } from "../../core/orchestration/runStateCapsule.js";
import type { TaskContract } from "../../core/orchestration/taskContract.js";
import { LEGACY_RESEARCH_LOOP_NODE_ID, assertCanonicalPolicy, resolveCanonicalSpecification } from "./canonicalTaskContractBuilder.js";
import { CanonicalRunRuntimeError, type CanonicalPlanningTool, type CompilePlanningContextInput } from "./canonicalRunTypes.js";

const MAX_TOOLS = 64;
const MAX_INSTRUCTIONS = 128;
const MAX_EVIDENCE = 512;
const MAX_ARTIFACTS = 512;
const MAX_MEMORIES = 64;
const MAX_PRIOR_OUTPUTS = 24;

export async function buildPlanningContextPack(
  input: CompilePlanningContextInput,
  contract: TaskContract,
  state: RunStateRevision,
  hasher: CanonicalHasher
): Promise<ContextPack> {
  assertCanonicalPolicy(input.policy);
  validatePlanningInput(input, state);
  const specification = resolveCanonicalSpecification(input.snapshot, input.specification);
  const tools = validateSelectedTools(input.selectedTools, input);
  const instructions = [policyInstruction(input, hasher), iterationInstruction(input), ...input.policyInstructions];
  if (specification) instructions.push(specificationInstruction(specification));
  const pack = await new ContextCompiler().compile({
    runId: input.owner.runId,
    projectId: input.owner.projectId,
    createdAt: input.compiledAt,
    taskContract: {
      id: contract.id,
      projectId: contract.projectId,
      contentHash: contract.contentHash,
      goal: contract.goal,
      normalizedUserIntent: contract.normalizedUserIntent,
      acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      constraints: [...contract.constraints],
      nonGoals: [...contract.nonGoals],
      requiredDeliverables: contract.requiredDeliverables.map((deliverable) => ({ ...deliverable })),
      riskPolicy: { ...contract.riskPolicy },
      approvalRequirements: contract.approvalRequirements.map((requirement) => ({ ...requirement })),
      resourceBudget: { ...contract.resourceBudget },
      ...(contract.deadline ? { deadline: contract.deadline } : {}),
      instructionProvenance: contract.instructionProvenance.map((item) => ({ ...item }))
    },
    runState: canonicalContextRunState(input, state),
    provider: { ...input.provider },
    instructions,
    evidence: input.evidence.map((evidence) => ({
      id: evidence.id,
      text: evidence.text,
      priority: evidence.priority,
      trust: evidence.trust,
      ...(evidence.dedupeKey ? { dedupeKey: evidence.dedupeKey } : {}),
      ...(evidence.sourceRefs ? { sourceRefs: [...evidence.sourceRefs] } : {})
    })),
    memories: input.memories.map(({ projectId, ...memory }) => {
      void projectId;
      return { ...memory, sourceRefs: [...(memory.sourceRefs ?? [])] };
    }),
    ...(input.selectedSkill ? { selectedSkill: { ...input.selectedSkill } } : {}),
    tools,
    artifacts: input.artifactHandles.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      sha256: artifact.sha256,
      priority: artifact.priority,
      trust: artifact.trust
    })),
    priorOutputs: input.priorOutputs.map(({ projectId, ...output }) => {
      void projectId;
      return {
        ...output,
        artifactHandles: output.artifactHandles.map((handle) => ({ ...handle }))
      };
    }),
    candidateSelections: {
      memory: { ...input.candidateSelections.memory, selectedIds: [...input.candidateSelections.memory.selectedIds] },
      priorOutputs: { ...input.candidateSelections.priorOutputs, selectedIds: [...input.candidateSelections.priorOutputs.selectedIds] }
    },
    budget: input.budget,
    ...(input.runtime ? { runtime: { ...input.runtime } } : {})
  });
  if (input.resumeContextBinding) assertResumeContextBinding(pack, input.resumeContextBinding, hasher);
  return pack;
}

function assertResumeContextBinding(pack: ContextPack, binding: ContextPackPersistenceReceipt, hasher: CanonicalHasher): void {
  if (
    binding.projectId !== pack.projectId ||
    binding.runId !== pack.runId ||
    binding.task.id !== pack.task.id ||
    binding.task.contentHash !== pack.task.contentHash ||
    binding.stateRevision >= pack.stateRevision
  ) {
    throw new CanonicalRunRuntimeError("CANONICAL_RESUME_CONFLICT", "Resume ContextPack binding does not precede the active canonical state.");
  }
  const candidate = createContextPackPersistenceReceipt(pack, hasher);
  const sectionKinds = ["evidence", "memory", "tools", "artifacts", "history"] as const;
  for (const kind of sectionKinds) {
    const actual = candidate.sections.find((section) => section.kind === kind);
    const expected = binding.sections.find((section) => section.kind === kind);
    if (hasher.sha256Canonical(actual) !== hasher.sha256Canonical(expected)) {
      throw new CanonicalRunRuntimeError("CANONICAL_RESUME_CONFLICT", `Resume context ${kind} section differs from its checkpoint binding.`);
    }
  }
  const projection = (receipt: ContextPackPersistenceReceipt) => ({
    artifactHandles: receipt.artifactHandles,
    selectedMemoryIds: receipt.selectedMemoryIds,
    selectedToolSpecVersions: receipt.selectedToolSpecVersions,
    evidenceIds: receipt.evidenceIds,
    artifactIds: receipt.artifactIds,
    candidateSelections: receipt.receipts.candidateSelections
  });
  const expected = projection(binding);
  const actual = projection(candidate);
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (hasher.sha256Canonical(actual[key]) !== hasher.sha256Canonical(expected[key])) {
      throw new CanonicalRunRuntimeError("CANONICAL_RESUME_CONFLICT", `Resume context ${key} differ from the checkpoint-bound ContextPack receipt.`);
    }
  }
}

function validatePlanningInput(input: CompilePlanningContextInput, state: RunStateRevision): void {
  if (!Number.isSafeInteger(input.iteration) || input.iteration < 1) invalid("Planning iteration must be a positive integer.");
  if (
    input.runtime?.forcedResetGeneration !== undefined &&
    (!Number.isSafeInteger(input.runtime.forcedResetGeneration) || input.runtime.forcedResetGeneration < 0)
  ) {
    invalid("Forced-reset generation must be a non-negative integer.");
  }
  if (input.snapshot.project.id !== input.owner.projectId) ownership("Planning snapshot ownership does not match the canonical run.");
  if (input.specification && input.specification.projectId !== input.owner.projectId)
    ownership("Planning specification ownership does not match the canonical run.");
  if (input.evidence.some((item) => item.projectId !== input.owner.projectId)) ownership("Planning evidence contains a cross-project reference.");
  if (input.artifactHandles.some((item) => item.projectId !== input.owner.projectId)) ownership("Planning artifacts contain a cross-project reference.");
  if (input.memories.some((item) => item.projectId !== input.owner.projectId)) ownership("Planning memory contains a cross-project reference.");
  if (input.priorOutputs.some((item) => item.projectId !== input.owner.projectId)) ownership("Planning prior output contains a cross-project reference.");
  if (state.currentNodeId !== LEGACY_RESEARCH_LOOP_NODE_ID || state.status !== "running") {
    throw new CanonicalRunRuntimeError("CANONICAL_RUN_NOT_READY", "Planning context requires the active canonical legacy research-loop node.");
  }
  assertBound(input.selectedTools.length, MAX_TOOLS, "selected tools");
  assertBound(input.policyInstructions.length, MAX_INSTRUCTIONS, "policy instructions");
  assertBound(input.evidence.length, MAX_EVIDENCE, "evidence entries");
  assertBound(input.artifactHandles.length, MAX_ARTIFACTS, "artifact handles");
  assertBound(input.memories.length, MAX_MEMORIES, "memory entries");
  assertBound(input.priorOutputs.length, MAX_PRIOR_OUTPUTS, "prior-output handles");
}

function canonicalContextRunState(input: CompilePlanningContextInput, state: RunStateRevision) {
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    projectId: state.projectId,
    status: state.status,
    revision: state.revision,
    parentRevisionHash: state.parentRevisionHash,
    stateHash: state.stateHash,
    taskContractId: state.taskContractId,
    taskContractHash: state.taskContractHash,
    taskGraph: {
      schemaVersion: state.taskGraph.schemaVersion,
      graphId: state.taskGraph.graphId,
      contentHash: state.taskGraph.contentHash,
      nodes: state.taskGraph.nodes.map((node) => ({ ...node, dependencyNodeIds: [...node.dependencyNodeIds] }))
    },
    currentNodeId: state.currentNodeId,
    ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
    iterationCompletedActionIds: completedActionIds(input),
    completedNodeReceipts: state.completedNodeReceipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      runId: receipt.runId,
      projectId: receipt.projectId,
      nodeId: receipt.nodeId,
      receiptHash: receipt.receiptHash,
      artifactRefs: receipt.artifactRefs.map((reference) => ({ ...reference })),
      evidenceRefs: receipt.evidenceRefs.map((reference) => ({ ...reference })),
      verifierReceiptIds: [...receipt.verifierReceiptIds],
      completedAt: receipt.completedAt
    })),
    pendingNodeIds: [...state.pendingNodeIds],
    artifactRefs: state.artifactRefs.map((reference) => ({ ...reference })),
    evidenceRefs: state.evidenceRefs.map((reference) => ({ ...reference })),
    verifiedFacts: state.verifiedFacts.map((reference) => ({ ...reference, evidenceIds: [...reference.evidenceIds] })),
    decisions: state.decisions.map((reference) => ({ ...reference })),
    assumptions: state.assumptions.map((reference) => ({ ...reference })),
    openQuestions: state.openQuestions.map((reference) => ({ ...reference })),
    blockedReasons: state.blockedReasons.map((reason) => ({ ...reason })),
    budgetLimits: { ...state.budgetLimits },
    budgetUsage: { ...state.budgetUsage },
    nextProposedNodeIds: [...state.nextProposedNodeIds],
    ...(state.terminalReceipt
      ? {
          terminalReceipt:
            state.terminalReceipt.outcome === "completed"
              ? {
                  receiptId: state.terminalReceipt.receiptId,
                  runId: state.terminalReceipt.runId,
                  projectId: state.terminalReceipt.projectId,
                  outcome: state.terminalReceipt.outcome,
                  completedNodeReceiptIds: [...state.terminalReceipt.completedNodeReceiptIds],
                  acceptanceReceiptIds: [...state.terminalReceipt.acceptanceReceiptIds],
                  createdAt: state.terminalReceipt.createdAt,
                  receiptHash: state.terminalReceipt.receiptHash
                }
              : {
                  receiptId: state.terminalReceipt.receiptId,
                  runId: state.terminalReceipt.runId,
                  projectId: state.terminalReceipt.projectId,
                  outcome: state.terminalReceipt.outcome,
                  completedNodeReceiptIds: [...state.terminalReceipt.completedNodeReceiptIds],
                  reasonCode: state.terminalReceipt.reasonCode,
                  createdAt: state.terminalReceipt.createdAt,
                  receiptHash: state.terminalReceipt.receiptHash
                }
        }
      : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

function validateSelectedTools(tools: CanonicalPlanningTool[], input: CompilePlanningContextInput) {
  const seen = new Set<string>();
  return [...tools]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    .map((tool) => {
      const key = tool.name.toLocaleLowerCase("en-US");
      if (seen.has(key)) policyViolation(`Duplicate selected tool descriptor: ${tool.name}`);
      seen.add(key);
      for (const capability of tool.requiredCapabilities) {
        if (!input.policy.effectiveCapabilities[capability]) policyViolation(`${tool.name} requires denied ${capability} capability.`);
      }
      if (tool.sideEffects.includes("network")) {
        if (!input.policy.effectiveCapabilities.search) policyViolation(`${tool.name} requires denied search capability.`);
        if (input.policy.toolPolicy.sourceAccess.mode === "offline") policyViolation(`${tool.name} is unavailable under offline source policy.`);
      }
      if (key === "codexclitool" && !input.policy.toolPolicy.allowCodexCli) {
        policyViolation("CodexCliTool is unavailable because this job did not opt in.");
      }
      return {
        name: tool.name,
        version: tool.version,
        summary: tool.summary,
        inputContractHash: tool.inputContractHash,
        available: true,
        priority: tool.priority
      };
    });
}

function policyInstruction(input: CompilePlanningContextInput, hasher: CanonicalHasher): ContextTextCandidate {
  const policy = {
    requestedCapabilities: input.policy.requestedCapabilities,
    effectiveCapabilities: input.policy.effectiveCapabilities,
    allowCodexCli: input.policy.toolPolicy.allowCodexCli,
    sourceAccess: canonicalSourceAccess(input)
  };
  return {
    id: `policy:${hasher.sha256Canonical(policy).slice(0, 32)}`,
    text: `Immutable job policy: ${JSON.stringify(policy)}`,
    priority: 1_000,
    trust: "system"
  };
}

function canonicalSourceAccess(input: CompilePlanningContextInput) {
  const source = input.policy.toolPolicy.sourceAccess;
  if (source.mode === "allowlist") return { mode: source.mode, urls: [...new Set(source.urls)].sort() };
  if (source.mode === "discovery") return { mode: source.mode, allowedDomains: [...new Set(source.allowedDomains)].sort() };
  return { mode: "offline" as const };
}

function iterationInstruction(input: CompilePlanningContextInput): ContextTextCandidate {
  return {
    id: `iteration:${input.iteration}`,
    text: `Current legacy research-loop iteration: ${input.iteration}.`,
    priority: 950,
    trust: "project"
  };
}

function specificationInstruction(specification: NonNullable<CompilePlanningContextInput["specification"]>): ContextTextCandidate {
  const lines = [
    `Scope: ${specification.scope}`,
    `Questions: ${[...specification.researchQuestions].sort().join(" | ") || "none"}`,
    `Hypotheses: ${[...specification.refinedHypotheses].sort().join(" | ") || "none"}`,
    `Constraints: ${[...specification.constraints].sort().join(" | ") || "none"}`,
    `Success criteria: ${[...specification.successCriteria].sort().join(" | ") || "none"}`
  ];
  return { id: `specification:${specification.id}`, text: lines.join("\n"), priority: 900, trust: "project", sourceRefs: [specification.id] };
}

function completedActionIds(input: CompilePlanningContextInput): string[] {
  return input.snapshot.toolRuns
    .filter((run) => run.iteration === input.iteration && run.status === "completed")
    .map((run) => run.originAttemptId ?? run.id)
    .filter((id, index, values) => values.indexOf(id) === index)
    .sort();
}

function assertBound(actual: number, maximum: number, label: string): void {
  if (actual > maximum) invalid(`Canonical planning ${label} exceed the ${maximum}-entry bound.`);
}

function invalid(message: string): never {
  throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", message);
}

function ownership(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", message);
}

function policyViolation(message: string): never {
  throw new CanonicalRunRuntimeError("TOOL_POLICY_VIOLATION", message);
}
