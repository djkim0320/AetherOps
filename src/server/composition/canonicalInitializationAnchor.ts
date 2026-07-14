import { deepFreeze, type CanonicalHasher } from "../../core/orchestration/orchestrationSchemas.js";
import { ResourceBudgetSchema } from "../../core/orchestration/taskContract.js";
import type { ResearchSpecification } from "../../core/shared/researchTypes.js";
import {
  assertCanonicalPolicy,
  assertCanonicalRunInput,
  buildCanonicalTaskContractFromSource,
  canonicalImmutableJobPolicy,
  canonicalTaskContractSource,
  type CanonicalTaskContractSource
} from "./canonicalTaskContractBuilder.js";
import { CanonicalRunRuntimeError, type CanonicalRunPolicy, type CanonicalTaskLimits, type PrepareCanonicalRunInput } from "./canonicalRunTypes.js";

type ImmutablePolicy = ReturnType<typeof canonicalImmutableJobPolicy>;

export interface CanonicalInitializationAnchor {
  schemaVersion: 1;
  projectId: string;
  taskSource: CanonicalTaskContractSource;
  immutablePolicy: ImmutablePolicy;
  taskLimits: CanonicalTaskLimits;
  contentHash: string;
}

export interface CreateCanonicalInitializationAnchorInput {
  snapshot: PrepareCanonicalRunInput["snapshot"];
  specification?: ResearchSpecification;
  policy: CanonicalRunPolicy;
  taskLimits: CanonicalTaskLimits;
}

export function createCanonicalInitializationAnchor(input: CreateCanonicalInitializationAnchorInput, hasher: CanonicalHasher): CanonicalInitializationAnchor {
  const projectId = input.snapshot.project.id;
  assertCanonicalRunInput(
    { projectId, runId: "run:initialization-anchor", jobId: "job:initialization-anchor" },
    input.snapshot,
    input.specification,
    input.snapshot.project.createdAt
  );
  assertCanonicalPolicy(input.policy);
  const body = {
    schemaVersion: 1 as const,
    projectId,
    taskSource: canonicalTaskContractSource(input.snapshot, input.specification, hasher),
    immutablePolicy: canonicalImmutableJobPolicy(input.policy),
    taskLimits: ResourceBudgetSchema.parse(input.taskLimits)
  };
  return deepFreeze({ ...body, contentHash: hasher.sha256Canonical(body) }) as CanonicalInitializationAnchor;
}

export function anchoredCanonicalPreparation(input: PrepareCanonicalRunInput, rawAnchor: unknown, hasher: CanonicalHasher) {
  const anchor = parseCanonicalInitializationAnchor(rawAnchor, hasher);
  if (anchor.projectId !== input.owner.projectId) ownership("Canonical initialization anchor belongs to another project.");
  if (hasher.sha256Canonical(anchor.immutablePolicy) !== hasher.sha256Canonical(canonicalImmutableJobPolicy(input.policy))) {
    mismatch("Canonical initialization anchor policy differs from the immutable root job policy.");
  }
  if (hasher.sha256Canonical(anchor.taskLimits) !== hasher.sha256Canonical(input.taskLimits)) {
    mismatch("Canonical initialization anchor resource budget differs from the root job budget.");
  }
  const taskContract = buildCanonicalTaskContractFromSource(
    {
      owner: input.owner,
      source: anchor.taskSource,
      policy: input.policy,
      taskLimits: input.taskLimits,
      preparedAt: input.preparedAt
    },
    hasher
  );
  return { anchor, taskContract };
}

export function parseCanonicalInitializationAnchor(raw: unknown, hasher: CanonicalHasher): CanonicalInitializationAnchor {
  if (!isRecord(raw)) mismatch("Canonical initialization anchor is missing or malformed.");
  assertExactKeys(raw, ["schemaVersion", "projectId", "taskSource", "immutablePolicy", "taskLimits", "contentHash"], "anchor");
  if (raw.schemaVersion !== 1 || !stableId(raw.projectId) || !sha256(raw.contentHash)) {
    mismatch("Canonical initialization anchor identity or hash is malformed.");
  }
  const taskSource = parseTaskSource(raw.taskSource, raw.projectId);
  const immutablePolicy = parseImmutablePolicy(raw.immutablePolicy, hasher);
  const taskLimits = ResourceBudgetSchema.safeParse(raw.taskLimits);
  if (!taskLimits.success) mismatch("Canonical initialization anchor resource budget is malformed.");
  const body = { schemaVersion: 1 as const, projectId: raw.projectId, taskSource, immutablePolicy, taskLimits: taskLimits.data };
  if (hasher.sha256Canonical(body) !== raw.contentHash.toLowerCase()) mismatch("Canonical initialization anchor hash verification failed.");
  return deepFreeze({ ...body, contentHash: raw.contentHash.toLowerCase() }) as CanonicalInitializationAnchor;
}

function parseTaskSource(raw: unknown, projectId: string): CanonicalTaskContractSource {
  if (!isRecord(raw)) mismatch("Canonical initialization task source is malformed.");
  assertAllowedKeys(raw, ["project", "researchInput", "specification"], "task source");
  const project = raw.project;
  if (!isRecord(project)) mismatch("Canonical initialization project source is malformed.");
  assertExactKeys(project, ["id", "goal", "scope", "budget"], "project source");
  if (project.id !== projectId || !text(project.goal) || !text(project.scope) || !text(project.budget)) {
    ownership("Canonical initialization project source is invalid or cross-project.");
  }
  const researchInput = raw.researchInput === undefined ? undefined : parseResearchInput(raw.researchInput, projectId);
  const specification = raw.specification === undefined ? undefined : parseSpecification(raw.specification, projectId);
  return {
    project: { id: project.id, goal: project.goal, scope: project.scope, budget: project.budget },
    ...(researchInput ? { researchInput } : {}),
    ...(specification ? { specification } : {})
  };
}

function parseResearchInput(raw: unknown, projectId: string): NonNullable<CanonicalTaskContractSource["researchInput"]> {
  if (!isRecord(raw)) mismatch("Canonical initialization research input is malformed.");
  assertExactKeys(raw, ["id", "projectId", "researchQuestion", "constraints", "expectedOutputs", "createdAt"], "research input");
  if (
    !stableId(raw.id) ||
    raw.projectId !== projectId ||
    !text(raw.researchQuestion) ||
    !textArray(raw.constraints) ||
    !textArray(raw.expectedOutputs) ||
    !timestamp(raw.createdAt)
  ) {
    ownership("Canonical initialization research input is invalid or cross-project.");
  }
  return {
    id: raw.id,
    projectId: raw.projectId,
    researchQuestion: raw.researchQuestion,
    constraints: [...raw.constraints],
    expectedOutputs: [...raw.expectedOutputs],
    createdAt: raw.createdAt
  };
}

function parseSpecification(raw: unknown, projectId: string): ResearchSpecification {
  if (!isRecord(raw) || !stableId(raw.id) || raw.projectId !== projectId || !timestamp(raw.createdAt)) {
    ownership("Canonical initialization specification is invalid or cross-project.");
  }
  assertAllowedKeys(
    raw,
    [
      "id",
      "projectId",
      "sourceResearchInputId",
      "sourceQuestionIds",
      "sourceHypothesisIds",
      "researchQuestions",
      "initialHypotheses",
      "refinedHypotheses",
      "scope",
      "assumptions",
      "constraints",
      "successCriteria",
      "requiredEvidenceTypes",
      "competencyQuestions",
      "evaluationMetrics",
      "createdAt"
    ],
    "specification"
  );
  const arrayKeys = [
    "researchQuestions",
    "initialHypotheses",
    "refinedHypotheses",
    "assumptions",
    "constraints",
    "successCriteria",
    "requiredEvidenceTypes",
    "competencyQuestions",
    "evaluationMetrics"
  ];
  if (
    !text(raw.scope) ||
    arrayKeys.some((key) => !textArray(raw[key])) ||
    (raw.sourceResearchInputId !== undefined && !stableId(raw.sourceResearchInputId)) ||
    (raw.sourceQuestionIds !== undefined && !textArray(raw.sourceQuestionIds)) ||
    (raw.sourceHypothesisIds !== undefined && !textArray(raw.sourceHypothesisIds))
  ) {
    mismatch("Canonical initialization specification fields are malformed.");
  }
  return structuredClone(raw) as unknown as ResearchSpecification;
}

function parseImmutablePolicy(raw: unknown, hasher: CanonicalHasher): ImmutablePolicy {
  if (!isRecord(raw)) mismatch("Canonical initialization policy is malformed.");
  const policy = { ...raw, externalSideEffects: [] } as unknown as CanonicalRunPolicy;
  try {
    assertCanonicalPolicy(policy);
  } catch {
    mismatch("Canonical initialization policy is malformed.");
  }
  const canonical = canonicalImmutableJobPolicy(policy);
  if (hasher.sha256Canonical(canonical) !== hasher.sha256Canonical(raw)) mismatch("Canonical initialization policy is not normalized.");
  return canonical;
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) mismatch(`Canonical initialization ${label} has unknown or missing fields.`);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) mismatch(`Canonical initialization ${label} has unknown fields.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function mismatch(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_TASK_MISMATCH", message);
}

function ownership(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", message);
}
