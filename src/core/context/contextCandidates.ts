import { redactContextText } from "./contextRedaction.js";
import { validateContextCandidateSelections } from "./contextCandidateSelections.js";
import { normalizeContextRunState, renderContextRunState } from "./contextRunState.js";
import { validateRecentConversationWindow } from "./contextRecentConversation.js";
import {
  CONTEXT_SECTION_ORDER,
  ContextCompilerError,
  type ContextArtifactHandle,
  type ContextCompilerInput,
  type ContextMarker,
  type ContextPackTool,
  type ContextPackSkill,
  type ContextRedactionReceipt,
  type ContextSectionKind,
  type ContextTextCandidate,
  type ContextTrustLabel
} from "./contextTypes.js";

const STABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUST = new Set<ContextTrustLabel>(["system", "project", "verified", "tool", "untrusted", "stale"]);
const TRUST_RANK: Record<ContextTrustLabel, number> = { system: 5, verified: 4, project: 3, tool: 2, untrusted: 1, stale: 0 };

export interface PreparedContextCandidate {
  id: string;
  section: ContextSectionKind;
  content: string;
  priority: number;
  trust: ContextTrustLabel;
  markers: ContextMarker[];
  sourceRefs: string[];
  dedupeKey: string;
  truncatable: boolean;
  artifactHandle?: ContextArtifactHandle;
  tool?: ContextPackTool;
  skill?: ContextPackSkill;
}

export interface PreparedContextInput {
  candidates: PreparedContextCandidate[];
  redactions: ContextRedactionReceipt[];
  removedTools: Array<{ name: string; version: string; reason: "not_available" }>;
  omittedPriorOutputs: Array<{ outputId: string; reason: "artifact_handles_only" }>;
}

export function prepareContextInput(input: ContextCompilerInput): PreparedContextInput {
  validateStructuralInput(input);
  const candidates: PreparedContextCandidate[] = [];
  const redactions: ContextRedactionReceipt[] = [];
  candidates.push(preparedText(`task:${input.taskContract.id}`, "task", taskText(input), 1_000, "system", [], [], undefined, redactions, false));
  candidates.push(
    preparedText(`run-state:${input.runState.revision}`, "run_state", runStateText(input), 1_000, "project", [], [], undefined, redactions, false)
  );
  appendTextCandidates(candidates, redactions, input.instructions, "instructions");
  appendTextCandidates(candidates, redactions, input.evidence, "evidence");
  for (const memory of input.memories) {
    const stale = memory.stale;
    const suffix = stale && memory.lastValidatedRevision !== undefined ? `\nLast validated revision: ${memory.lastValidatedRevision}` : "";
    candidates.push(
      preparedText(
        memory.id,
        "memory",
        `${memory.text}${suffix}`,
        memory.priority,
        stale ? "stale" : memory.trust,
        stale ? ["STALE_MEMORY_REVALIDATION_REQUIRED"] : [],
        memory.sourceRefs ?? [],
        memory.dedupeKey,
        redactions
      )
    );
  }
  const tools = prepareTools(input, redactions);
  if (input.selectedSkill) candidates.push(prepareSkill(input.selectedSkill, redactions));
  candidates.push(...tools.candidates);
  candidates.push(...prepareArtifactCandidates(input));
  candidates.push(...prepareRecentConversation(input, redactions));
  return {
    candidates,
    redactions: redactions.sort((left, right) => left.entryId.localeCompare(right.entryId)),
    removedTools: tools.removedTools,
    omittedPriorOutputs: input.priorOutputs
      .filter((output) => output.rawOutput !== undefined)
      .map((output) => ({ outputId: output.id, reason: "artifact_handles_only" as const }))
      .sort((left, right) => left.outputId.localeCompare(right.outputId))
  };
}

function prepareRecentConversation(input: ContextCompilerInput, redactions: ContextRedactionReceipt[]): PreparedContextCandidate[] {
  const window = input.recentConversationWindow;
  if (!window) return [];
  return [...window.entries]
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .map((entry) =>
      preparedText(
        `recent:${entry.id}`,
        "history",
        entry.text,
        entry.priority,
        "project",
        [],
        entry.sourceRefs ?? [],
        `recent:${entry.contentHash}`,
        redactions
      )
    );
}

export function deduplicateContextCandidates(candidates: PreparedContextCandidate[]): {
  candidates: PreparedContextCandidate[];
  receipts: Array<{ keptId: string; droppedId: string }>;
} {
  const ordered = [...candidates].sort(compareForDedupe);
  const byKey = new Map<string, PreparedContextCandidate>();
  const receipts: Array<{ keptId: string; droppedId: string }> = [];
  for (const candidate of ordered) {
    const kept = byKey.get(candidate.dedupeKey);
    if (kept) receipts.push({ keptId: kept.id, droppedId: candidate.id });
    else byKey.set(candidate.dedupeKey, candidate);
  }
  return {
    candidates: [...byKey.values()],
    receipts: receipts.sort((left, right) => left.droppedId.localeCompare(right.droppedId))
  };
}

export function compareContextPriority(left: PreparedContextCandidate, right: PreparedContextCandidate): number {
  return right.priority - left.priority || TRUST_RANK[right.trust] - TRUST_RANK[left.trust] || left.id.localeCompare(right.id);
}

function appendTextCandidates(
  output: PreparedContextCandidate[],
  redactions: ContextRedactionReceipt[],
  values: ContextTextCandidate[],
  section: "instructions" | "evidence"
): void {
  for (const value of values) {
    if (value.sensitivity === "secret") {
      redactions.push({ entryId: value.id, replacements: 1, categories: ["sensitive_candidate"] });
    }
    output.push(
      preparedText(
        value.id,
        section,
        value.sensitivity === "secret" ? "[REDACTED:sensitive_candidate]" : value.text,
        value.priority,
        value.trust,
        [],
        value.sourceRefs ?? [],
        value.dedupeKey,
        redactions,
        !(section === "instructions" && value.trust === "system")
      )
    );
  }
}

function preparedText(
  id: string,
  section: ContextSectionKind,
  rawText: string,
  priority: number,
  trust: ContextTrustLabel,
  markers: ContextMarker[],
  sourceRefs: string[],
  explicitDedupeKey: string | undefined,
  receipts: ContextRedactionReceipt[],
  truncatable = true
): PreparedContextCandidate {
  assertStableId(id, "entry id");
  assertPriority(priority, id);
  if (!TRUST.has(trust)) invalid(`Context entry has an unsupported trust label: ${id}`);
  const normalized = normalizeText(rawText);
  if (!normalized || normalized.length > 100_000) invalid(`Context entry text must contain 1 to 100000 characters: ${id}`);
  const redacted = redactContextText(normalized);
  if (redacted.replacements) receipts.push({ entryId: id, replacements: redacted.replacements, categories: redacted.categories });
  const dedupeKey = explicitDedupeKey ? `explicit:${normalizeDedupeKey(explicitDedupeKey)}` : `text:${normalizeDedupeKey(redacted.text)}`;
  return {
    id,
    section,
    content: redacted.text,
    priority,
    trust,
    markers,
    sourceRefs: uniqueStableIds(sourceRefs, `source refs for ${id}`),
    dedupeKey,
    truncatable
  };
}

function prepareSkill(skill: NonNullable<ContextCompilerInput["selectedSkill"]>, redactions: ContextRedactionReceipt[]): PreparedContextCandidate {
  assertStableId(skill.id, "skill id");
  assertStableId(skill.version, `skill version for ${skill.id}`);
  assertHash(skill.contentHash, `skill ${skill.id}`);
  assertPriority(skill.priority, `skill:${skill.id}`);
  const id = `skill:${skill.id}`;
  const redacted = redactContextText(normalizeText(skill.summary));
  if (!redacted.text) invalid(`Skill summary is required: ${skill.id}`);
  if (redacted.replacements) redactions.push({ entryId: id, replacements: redacted.replacements, categories: redacted.categories });
  return {
    id,
    section: "skill",
    content: `${skill.id}@${skill.version} | ${redacted.text} | content=${skill.contentHash}`,
    priority: skill.priority,
    trust: "system",
    markers: [],
    sourceRefs: [],
    dedupeKey: id,
    truncatable: false,
    skill: { id: skill.id, version: skill.version, contentHash: skill.contentHash }
  };
}

function prepareTools(input: ContextCompilerInput, redactions: ContextRedactionReceipt[]) {
  const candidates: PreparedContextCandidate[] = [];
  const removedTools: Array<{ name: string; version: string; reason: "not_available" }> = [];
  const availableByName = new Map<string, PreparedContextCandidate>();
  for (const tool of [...input.tools].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))) {
    assertStableId(tool.name, "tool name");
    assertStableId(tool.version, `tool version for ${tool.name}`);
    assertHash(tool.inputContractHash, `tool input contract for ${tool.name}`);
    assertPriority(tool.priority, `tool:${tool.name}`);
    if (!tool.available) {
      removedTools.push({ name: tool.name, version: tool.version, reason: "not_available" });
      continue;
    }
    const id = `tool:${tool.name}`;
    const redacted = redactContextText(normalizeText(tool.summary));
    if (redacted.replacements) redactions.push({ entryId: id, replacements: redacted.replacements, categories: redacted.categories });
    const descriptor = { name: tool.name, version: tool.version, summary: redacted.text, inputContractHash: tool.inputContractHash };
    const candidate: PreparedContextCandidate = {
      id,
      section: "tools",
      content: `${tool.name}@${tool.version} | ${redacted.text} | input=${tool.inputContractHash}`,
      priority: tool.priority,
      trust: "system",
      markers: [],
      sourceRefs: [],
      dedupeKey: `tool:${tool.name}`,
      truncatable: false,
      tool: descriptor
    };
    const existing = availableByName.get(tool.name);
    if (existing && !sameTool(existing.tool!, descriptor))
      throw new ContextCompilerError("CONFLICTING_TOOL_DESCRIPTOR", `Conflicting descriptors for tool: ${tool.name}`);
    if (!existing || candidate.priority > existing.priority) availableByName.set(tool.name, candidate);
  }
  candidates.push(...availableByName.values());
  return { candidates, removedTools: removedTools.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)) };
}

function prepareArtifactCandidates(input: ContextCompilerInput): PreparedContextCandidate[] {
  const output: PreparedContextCandidate[] = [];
  for (const artifact of input.artifacts)
    output.push(artifactCandidate(`artifact:${artifact.artifactId}`, "artifacts", artifact, artifact.priority, artifact.trust));
  for (const prior of input.priorOutputs) {
    assertStableId(prior.id, "prior output id");
    assertPriority(prior.priority, prior.id);
    for (const handle of prior.artifactHandles)
      output.push(artifactCandidate(`history:${prior.id}:${handle.artifactId}`, "history", handle, prior.priority, prior.trust));
  }
  return output;
}

function artifactCandidate(
  id: string,
  section: "artifacts" | "history",
  handle: ContextArtifactHandle,
  priority: number,
  trust: Exclude<ContextTrustLabel, "stale">
): PreparedContextCandidate {
  assertStableId(handle.artifactId, "artifact id");
  assertStableId(handle.kind, `artifact kind for ${handle.artifactId}`);
  assertHash(handle.sha256, `artifact ${handle.artifactId}`);
  assertPriority(priority, id);
  const value = { artifactId: handle.artifactId, kind: handle.kind, sha256: handle.sha256 };
  return {
    id,
    section,
    content: `${value.artifactId}|${value.kind}|${value.sha256}`,
    priority,
    trust,
    markers: [],
    sourceRefs: [],
    dedupeKey: `artifact:${value.sha256}`,
    truncatable: false,
    artifactHandle: value
  };
}

function validateStructuralInput(input: ContextCompilerInput): void {
  if (!input || typeof input !== "object") invalid("Context compiler input is required.");
  assertStableId(input.runId, "run id");
  assertStableId(input.projectId, "project id");
  if (!Number.isFinite(Date.parse(input.createdAt))) invalid("Context createdAt must be an ISO-8601 timestamp.");
  assertStableId(input.taskContract.id, "task contract id");
  assertStableId(input.taskContract.projectId, "task contract project id");
  if (input.taskContract.projectId !== input.projectId) invalid("Task contract ownership does not match the context project.");
  assertHash(input.taskContract.contentHash, "task contract");
  assertStableId(input.provider.providerId, "provider id");
  assertStableId(input.provider.modelId, "model id");
  const recent = input.recentConversationWindow;
  validateRecentConversationWindow(recent);
  const runState = normalizeContextRunState(input.runState);
  if (runState.runId !== input.runId || runState.projectId !== input.projectId) invalid("Run-state ownership does not match the context envelope.");
  if (runState.taskContractId !== input.taskContract.id || runState.taskContractHash !== input.taskContract.contentHash) {
    invalid("Run-state task binding does not match the context task contract.");
  }
  validateContextCandidateSelections(input);
  const arrays = [input.instructions, input.evidence, input.memories, input.tools, input.artifacts, input.priorOutputs, recent?.entries ?? []];
  if (arrays.some((values) => !Array.isArray(values)) || arrays.reduce((sum, values) => sum + values.length, 0) > 2_000) {
    invalid("Context candidate arrays are required and may contain at most 2000 total entries.");
  }
}

function taskText(input: ContextCompilerInput): string {
  const contract = input.taskContract;
  return [
    `Goal: ${contract.goal}`,
    `Normalized user intent: ${contract.normalizedUserIntent}`,
    `Acceptance criteria: ${contract.acceptanceCriteria
      .map((criterion) => `${criterion.id}:${criterion.description}[${criterion.verifierKind}]`)
      .sort()
      .join(" | ")}`,
    `Constraints: ${[...contract.constraints].sort().join(" | ") || "none"}`,
    `Non-goals: ${[...contract.nonGoals].sort().join(" | ") || "none"}`,
    `Required deliverables: ${
      contract.requiredDeliverables
        .map((deliverable) => `${deliverable.id}:${deliverable.kind}:${deliverable.description}`)
        .sort()
        .join(" | ") || "none"
    }`,
    `Risk policy: maximum=${contract.riskPolicy.maximumRisk}; verify-before-promotion=${contract.riskPolicy.requireVerificationBeforePromotion}; external-instructions-as-data=${contract.riskPolicy.treatExternalInstructionsAsData}`,
    `Approvals: ${
      contract.approvalRequirements
        .map((requirement) => `${requirement.id}:${requirement.trigger}:${requirement.mode}`)
        .sort()
        .join(" | ") || "none"
    }`,
    `Resource budget: ${JSON.stringify(contract.resourceBudget)}`,
    `Deadline: ${contract.deadline ?? "none"}`,
    `Instruction provenance: ${contract.instructionProvenance
      .map((item) => `${item.instructionId}:${item.source}:${item.contentHash}:${item.receivedAt}`)
      .sort()
      .join(" | ")}`
  ].join("\n");
}

function runStateText(input: ContextCompilerInput): string {
  return renderContextRunState(input.runState);
}

function compareForDedupe(left: PreparedContextCandidate, right: PreparedContextCandidate): number {
  return (
    TRUST_RANK[right.trust] - TRUST_RANK[left.trust] ||
    right.priority - left.priority ||
    CONTEXT_SECTION_ORDER.indexOf(left.section) - CONTEXT_SECTION_ORDER.indexOf(right.section) ||
    left.id.localeCompare(right.id)
  );
}

function sameTool(left: ContextPackTool, right: ContextPackTool): boolean {
  return left.version === right.version && left.summary === right.summary && left.inputContractHash === right.inputContractHash;
}

function uniqueStableIds(values: string[], label: string): string[] {
  const output = [...new Set(values)].sort();
  for (const value of output) assertStableId(value, label);
  return output;
}

function normalizeText(value: string): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
}

function normalizeDedupeKey(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > 100_000) invalid("Context deduplication key is invalid.");
  return normalized;
}

function assertStableId(value: string, label: string): void {
  if (typeof value !== "string" || !STABLE_ID.test(value)) invalid(`${label} must be a stable identifier.`);
}

function assertHash(value: string, label: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} must have a lowercase SHA-256 hash.`);
}

function assertPriority(value: number, id: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000) invalid(`Context priority must be an integer from 0 to 1000: ${id}`);
}

function invalid(message: string): never {
  throw new ContextCompilerError("INVALID_CONTEXT_INPUT", message);
}
