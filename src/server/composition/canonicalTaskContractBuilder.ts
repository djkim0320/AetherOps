import { StableIdentifierSchema } from "../../core/orchestration/orchestrationSchemas.js";
import { CANONICAL_BUDGET_ACCOUNTING_INSTRUCTION_ID, CANONICAL_BUDGET_ACCOUNTING_POLICY } from "../../core/orchestration/budgetAccounting.js";
import { buildResearchInputPayloadFromBrief } from "../../core/input/researchInput.js";
import type { CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import { parseTaskGraph, taskGraphHashPayload, type TaskGraph } from "../../core/orchestration/taskGraph.js";
import { parseTaskContract, taskContractHashPayload, type TaskContract } from "../../core/orchestration/taskContract.js";
import type { ResearchSnapshot } from "../../core/shared/evaluationTypes.js";
import type { ResearchSpecification } from "../../core/shared/researchTypes.js";
import { CanonicalRunRuntimeError, type CanonicalRunOwner, type CanonicalRunPolicy, type PrepareCanonicalRunInput } from "./canonicalRunTypes.js";

export const LEGACY_RESEARCH_LOOP_NODE_ID = "legacy-research-loop";

export interface CanonicalTaskContractSource {
  project: { id: string; goal: string; scope: string; budget: string };
  researchInput?: {
    id: string;
    projectId: string;
    researchQuestion: string;
    constraints: string[];
    expectedOutputs: string[];
    createdAt: string;
  };
  specification?: ResearchSpecification;
}

export interface CanonicalTaskContractSourceInput {
  owner: CanonicalRunOwner;
  source: CanonicalTaskContractSource;
  policy: CanonicalRunPolicy;
  taskLimits: PrepareCanonicalRunInput["taskLimits"];
  preparedAt: string;
}

export function buildCanonicalTaskContract(input: PrepareCanonicalRunInput, hasher: CanonicalHasher): TaskContract {
  assertCanonicalRunInput(input.owner, input.snapshot, input.specification, input.preparedAt);
  return buildCanonicalTaskContractFromSource(
    {
      owner: input.owner,
      source: canonicalTaskContractSource(input.snapshot, input.specification, hasher),
      policy: input.policy,
      taskLimits: input.taskLimits,
      preparedAt: input.preparedAt
    },
    hasher
  );
}

export function buildCanonicalTaskContractFromSource(input: CanonicalTaskContractSourceInput, hasher: CanonicalHasher): TaskContract {
  assertCanonicalSourceInput(input);
  assertCanonicalPolicy(input.policy);
  const { specification, researchInput } = input.source;
  const goal = requiredText(input.source.project.goal, "project goal");
  const normalizedUserIntent = requiredText(researchInput?.researchQuestion ?? goal, "normalized user intent");
  const seedHash = hasher.sha256Canonical({
    schemaVersion: 1,
    projectId: input.owner.projectId,
    runId: input.owner.runId,
    goal,
    normalizedUserIntent,
    specificationId: specification?.id ?? null,
    jobPolicy: canonicalImmutableJobPolicy(input.policy)
  });
  const contractWithoutHash = {
    schemaVersion: 1 as const,
    id: `task:${seedHash.slice(0, 48)}`,
    projectId: input.owner.projectId,
    goal,
    normalizedUserIntent,
    acceptanceCriteria: acceptanceCriteria(specification, hasher),
    constraints: contractConstraints(input.source.project, researchInput?.constraints ?? [], specification),
    nonGoals: contractNonGoals(input.policy),
    requiredDeliverables: requiredDeliverables(researchInput?.expectedOutputs ?? [], hasher),
    riskPolicy: {
      maximumRisk:
        input.policy.effectiveCapabilities.engineering || input.policy.toolPolicy.allowCodexCli ? ("reversible_write" as const) : ("read_only" as const),
      requireVerificationBeforePromotion: true as const,
      treatExternalInstructionsAsData: true as const
    },
    approvalRequirements: approvalRequirements(input.policy),
    resourceBudget: { ...input.taskLimits },
    instructionProvenance: instructionProvenance(input.source, input.policy, input.preparedAt, hasher),
    createdAt: input.preparedAt
  };
  return parseTaskContract(
    { ...contractWithoutHash, contentHash: hasher.sha256Canonical(taskContractHashPayload({ ...contractWithoutHash, contentHash: "0".repeat(64) })) },
    hasher
  );
}

export function canonicalTaskContractSource(
  snapshot: ResearchSnapshot,
  explicitSpecification: ResearchSpecification | undefined,
  hasher: CanonicalHasher
): CanonicalTaskContractSource {
  const specification = resolveCanonicalSpecification(snapshot, explicitSpecification);
  const researchInput = latestProjectItem(snapshot.researchInputs, snapshot.project.id) ?? researchInputFromProjectBrief(snapshot, hasher);
  return {
    project: {
      id: snapshot.project.id,
      goal: snapshot.project.goal,
      scope: snapshot.project.scope,
      budget: snapshot.project.budget
    },
    ...(researchInput
      ? {
          researchInput: {
            id: researchInput.id,
            projectId: researchInput.projectId,
            researchQuestion: researchInput.researchQuestion,
            constraints: [...researchInput.constraints],
            expectedOutputs: [...researchInput.expectedOutputs],
            createdAt: researchInput.createdAt
          }
        }
      : {}),
    ...(specification ? { specification: structuredClone(specification) } : {})
  };
}

function researchInputFromProjectBrief(snapshot: ResearchSnapshot, hasher: CanonicalHasher): NonNullable<CanonicalTaskContractSource["researchInput"]> {
  const payload = buildResearchInputPayloadFromBrief(snapshot.project);
  const source = {
    projectId: snapshot.project.id,
    researchQuestion: payload.researchQuestion,
    constraints: payload.constraints,
    expectedOutputs: payload.expectedOutputs.length ? payload.expectedOutputs : ["A verified research report satisfying the project goal."],
    createdAt: snapshot.project.updatedAt
  };
  return { id: `brief-input:${hasher.sha256Canonical(source).slice(0, 48)}`, ...source };
}

export function buildLegacyResearchTaskGraph(runId: string, hasher: CanonicalHasher): TaskGraph {
  assertStableId(runId, "run id");
  const graphWithoutHash = {
    schemaVersion: 1 as const,
    graphId: `graph:${hasher.sha256Canonical({ runId, kind: "legacy_research_loop", schemaVersion: 1 }).slice(0, 48)}`,
    nodes: [{ id: LEGACY_RESEARCH_LOOP_NODE_ID, kind: "legacy_research_loop", dependencyNodeIds: [], terminal: true }]
  };
  return parseTaskGraph(
    { ...graphWithoutHash, contentHash: hasher.sha256Canonical(taskGraphHashPayload({ ...graphWithoutHash, contentHash: "0".repeat(64) })) },
    hasher
  );
}

export function assertCanonicalRunInput(
  owner: CanonicalRunOwner,
  snapshot: ResearchSnapshot,
  specification: ResearchSpecification | undefined,
  timestamp: string
): void {
  assertStableId(owner.projectId, "project id");
  assertStableId(owner.runId, "run id");
  assertStableId(owner.jobId, "job id");
  if (!Number.isFinite(Date.parse(timestamp))) invalid("Canonical run timestamps must be ISO-8601 compatible.");
  if (snapshot.project.id !== owner.projectId) ownership("Snapshot ownership does not match the canonical run.");
  const owned = [...snapshot.researchInputs, ...snapshot.specifications, ...snapshot.toolRuns, ...snapshot.evidence, ...snapshot.artifacts];
  if (owned.some((item) => item.projectId !== owner.projectId)) ownership("Snapshot contains a cross-project research record.");
  if (specification && specification.projectId !== owner.projectId) ownership("Specification ownership does not match the canonical run.");
}

export function assertCanonicalPolicy(policy: CanonicalRunPolicy): void {
  const capabilities = ["agent", "engineering", "search"] as const;
  for (const capability of capabilities) {
    if (typeof policy.requestedCapabilities[capability] !== "boolean" || typeof policy.effectiveCapabilities[capability] !== "boolean") {
      invalid("Requested and effective capabilities must be complete boolean sets.");
    }
    if (policy.effectiveCapabilities[capability] && !policy.requestedCapabilities[capability]) {
      policyViolation(`Effective ${capability} capability exceeds the immutable job request.`);
    }
  }
  if (typeof policy.toolPolicy.allowCodexCli !== "boolean") invalid("allowCodexCli must be explicit.");
  const source = policy.toolPolicy.sourceAccess;
  if (!source || !["offline", "allowlist", "discovery"].includes(source.mode)) invalid("Source access mode is invalid.");
  if (source.mode === "allowlist" && (!Array.isArray(source.urls) || source.urls.length === 0 || source.urls.some((url) => !url))) {
    invalid("Allowlist source access requires at least one URL.");
  }
  if (source.mode === "discovery" && (!Array.isArray(source.allowedDomains) || source.allowedDomains.some((domain) => !domain))) {
    invalid("Discovery source access requires an allowedDomains array of non-empty domains.");
  }
  if (!Array.isArray(policy.externalSideEffects)) invalid("External side-effect status list is required.");
  const pending = policy.externalSideEffects.filter((effect) => effect.status === "queued" || effect.status === "running");
  const statuses = new Set(["queued", "running", "committed", "quarantined", "failed", "interrupted"]);
  const attemptIds = new Set<string>();
  for (const effect of policy.externalSideEffects) {
    assertStableId(effect.attemptId, "external side-effect attempt id");
    if (!statuses.has(effect.status)) invalid(`Unsupported external side-effect status: ${String(effect.status)}`);
    if (attemptIds.has(effect.attemptId)) invalid(`Duplicate external side-effect attempt: ${effect.attemptId}`);
    attemptIds.add(effect.attemptId);
  }
  if (pending.length > 0) {
    throw new CanonicalRunRuntimeError(
      "PENDING_EXTERNAL_SIDE_EFFECT",
      `Canonical execution is blocked by ${pending.length} external side-effect attempt(s) without terminal receipts.`
    );
  }
}

export function canonicalImmutableJobPolicy(policy: CanonicalRunPolicy) {
  return {
    requestedCapabilities: { ...policy.requestedCapabilities },
    effectiveCapabilities: { ...policy.effectiveCapabilities },
    toolPolicy:
      policy.toolPolicy.sourceAccess.mode === "allowlist"
        ? {
            allowCodexCli: policy.toolPolicy.allowCodexCli,
            sourceAccess: { mode: "allowlist" as const, urls: [...new Set(policy.toolPolicy.sourceAccess.urls)].sort() }
          }
        : policy.toolPolicy.sourceAccess.mode === "discovery"
          ? {
              allowCodexCli: policy.toolPolicy.allowCodexCli,
              sourceAccess: { mode: "discovery" as const, allowedDomains: [...new Set(policy.toolPolicy.sourceAccess.allowedDomains)].sort() }
            }
          : { allowCodexCli: policy.toolPolicy.allowCodexCli, sourceAccess: { mode: "offline" as const } }
  };
}

export function resolveCanonicalSpecification(snapshot: ResearchSnapshot, explicit: ResearchSpecification | undefined): ResearchSpecification | undefined {
  if (explicit) return explicit;
  return latestProjectItem(snapshot.specifications, snapshot.project.id);
}

function acceptanceCriteria(specification: ResearchSpecification | undefined, hasher: CanonicalHasher) {
  const descriptions = uniqueTexts([
    "Every promoted result is traceable to verified evidence and a terminal completion receipt.",
    "Execution remains within the immutable capability and source-access policy.",
    ...(specification?.successCriteria ?? [])
  ]);
  return descriptions.map((description) => ({
    id: `criterion:${hasher.sha256Canonical(description).slice(0, 32)}`,
    description,
    verifierKind: "deterministic" as const
  }));
}

function requiredDeliverables(outputs: string[], hasher: CanonicalHasher) {
  const descriptions = uniqueTexts(outputs.length > 0 ? outputs : ["A receipt-backed research result that satisfies the project goal."]);
  return descriptions.map((description) => ({
    id: `deliverable:${hasher.sha256Canonical(description).slice(0, 32)}`,
    kind: "report" as const,
    description
  }));
}

function contractConstraints(
  project: CanonicalTaskContractSource["project"],
  inputConstraints: string[],
  specification: ResearchSpecification | undefined
): string[] {
  return uniqueTexts([
    "Codex OAuth monetary cost is not provider-reported. A zero monetary limit explicitly authorizes unmetered cost accounting; no cost value is fabricated, while time, token-estimate, tool-call, retry, and output-byte limits remain enforced.",
    `Project scope: ${requiredText(project.scope, "project scope")}`,
    `Project budget: ${requiredText(project.budget, "project budget")}`,
    ...inputConstraints,
    ...(specification?.constraints ?? [])
  ]);
}

function contractNonGoals(policy: CanonicalRunPolicy): string[] {
  const values: string[] = [];
  if (policy.toolPolicy.sourceAccess.mode === "offline") values.push("Network source access is outside this run.");
  if (!policy.toolPolicy.allowCodexCli) values.push("Codex workspace execution is outside this run.");
  if (!policy.effectiveCapabilities.engineering) values.push("Engineering process execution is outside this run.");
  return values;
}

function approvalRequirements(policy: CanonicalRunPolicy) {
  const values: Array<{ id: string; trigger: "network" | "filesystem_write" | "process"; mode: "not_required" }> = [];
  if (policy.effectiveCapabilities.search && policy.toolPolicy.sourceAccess.mode !== "offline") {
    values.push({ id: "approval:network-job-policy", trigger: "network", mode: "not_required" });
  }
  if (policy.effectiveCapabilities.engineering || policy.toolPolicy.allowCodexCli) {
    values.push({ id: "approval:filesystem-job-policy", trigger: "filesystem_write", mode: "not_required" });
    values.push({ id: "approval:process-job-policy", trigger: "process", mode: "not_required" });
  }
  return values;
}

function instructionProvenance(source: CanonicalTaskContractSource, policy: CanonicalRunPolicy, preparedAt: string, hasher: CanonicalHasher) {
  const values: Array<{
    instructionId: string;
    source: "system_policy" | "repository_policy" | "project_policy" | "user";
    value: unknown;
  }> = [
    { instructionId: "instruction:repository-policy", source: "repository_policy" as const, value: "canonical-run-policy-v1" },
    {
      instructionId: CANONICAL_BUDGET_ACCOUNTING_INSTRUCTION_ID,
      source: "repository_policy" as const,
      value: CANONICAL_BUDGET_ACCOUNTING_POLICY
    },
    {
      instructionId: "instruction:project-brief",
      source: "user" as const,
      value: {
        id: source.project.id,
        goal: source.project.goal,
        scope: source.project.scope,
        budget: source.project.budget
      }
    },
    { instructionId: "instruction:job-policy", source: "project_policy" as const, value: canonicalImmutableJobPolicy(policy) }
  ];
  if (source.researchInput) {
    values.push({ instructionId: "instruction:research-input", source: "user", value: source.researchInput });
  }
  if (source.specification) {
    values.push({ instructionId: "instruction:research-specification", source: "project_policy", value: source.specification });
  }
  return values.map(({ instructionId, source, value }) => ({
    instructionId,
    source,
    contentHash: hasher.sha256Canonical(value),
    receivedAt: preparedAt
  }));
}

function assertCanonicalSourceInput(input: CanonicalTaskContractSourceInput): void {
  assertStableId(input.owner.projectId, "project id");
  assertStableId(input.owner.runId, "run id");
  assertStableId(input.owner.jobId, "job id");
  if (!Number.isFinite(Date.parse(input.preparedAt))) invalid("Canonical run timestamps must be ISO-8601 compatible.");
  if (input.source.project.id !== input.owner.projectId) ownership("Task-contract source ownership does not match the canonical run.");
  if (input.source.researchInput?.projectId !== undefined && input.source.researchInput.projectId !== input.owner.projectId) {
    ownership("Task-contract research input belongs to another project.");
  }
  if (input.source.specification?.projectId !== undefined && input.source.specification.projectId !== input.owner.projectId) {
    ownership("Task-contract specification belongs to another project.");
  }
}

function latestProjectItem<Item extends { id: string; projectId: string; createdAt: string }>(items: Item[], projectId: string): Item | undefined {
  return items
    .filter((item) => item.projectId === projectId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
}

function uniqueTexts(values: string[]): string[] {
  const normalized = values.map((value) => requiredText(value, "contract text"));
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function requiredText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) invalid(`${label} is required.`);
  return normalized;
}

function assertStableId(value: string, label: string): void {
  if (!StableIdentifierSchema.safeParse(value).success) invalid(`${label} must be a stable identifier.`);
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
