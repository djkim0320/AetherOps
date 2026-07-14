import { allocateContextBudget } from "./contextBudget.js";
import { deduplicateContextCandidates, prepareContextInput } from "./contextCandidates.js";
import { hashContextCanonical, hashContextText } from "./contextCanonical.js";
import { verifyContextProviderCapabilityReceipt } from "./contextProviderCapabilities.js";
import { verifyRecentConversationWindowHashes } from "./contextRecentConversation.js";
import { compileContextSections } from "./contextSections.js";
import { normalizeContextRunState } from "./contextRunState.js";
import { ContextCompilerError, type ContextCompilerInput, type ContextPack, type ContextPackBody } from "./contextTypes.js";

export class ContextCompiler {
  async compile(input: ContextCompilerInput): Promise<ContextPack> {
    await verifyProviderAndRecentCache(input);
    const prepared = prepareContextInput(input);
    const deduplicated = deduplicateContextCandidates(prepared.candidates);
    const compiled = compileContextSections(deduplicated.candidates, allocateContextBudget(input.budget));
    const finalInputHash = await hashContextText(compiled.providerInput);
    const body: ContextPackBody = {
      schemaVersion: 1,
      compilerVersion: "context-compiler-v1",
      runId: input.runId,
      projectId: input.projectId,
      stateRevision: input.runState.revision,
      task: { id: input.taskContract.id, contentHash: input.taskContract.contentHash },
      runState: normalizeContextRunState(input.runState),
      provider: {
        providerId: input.provider.providerId,
        modelId: input.provider.modelId,
        capabilityReceipt: {
          profile: structuredClone(input.provider.capabilityReceipt.profile),
          contentHash: input.provider.capabilityReceipt.contentHash
        }
      },
      sections: compiled.sections,
      providerInput: compiled.providerInput,
      availableTools: compiled.availableTools,
      artifactHandles: compiled.artifactHandles,
      selectedMemoryIds: selectedEntryIds(compiled.sections, "memory"),
      selectedSkillVersions: compiled.selectedSkills,
      selectedToolSpecVersions: compiled.availableTools.map(({ name, version, inputContractHash }) => ({ name, version, inputContractHash })),
      evidenceIds: selectedEntryIds(compiled.sections, "evidence"),
      artifactIds: compiled.artifactHandles.map((artifact) => artifact.artifactId),
      budget: compiled.budget,
      receipts: {
        deduplications: deduplicated.receipts,
        redactions: prepared.redactions,
        truncations: compiled.truncations,
        removedTools: prepared.removedTools,
        omittedPriorOutputs: prepared.omittedPriorOutputs,
        candidateSelections: {
          memory: { ...input.candidateSelections.memory, selectedIds: [...input.candidateSelections.memory.selectedIds].sort() },
          priorOutputs: { ...input.candidateSelections.priorOutputs, selectedIds: [...input.candidateSelections.priorOutputs.selectedIds].sort() }
        },
        ...(input.recentConversationWindow ? { recentConversation: recentConversationReceipt(input, compiled.sections) } : {})
      },
      finalInputHash,
      createdAt: input.createdAt
    };
    const canonicalHash = await hashContextCanonical(body);
    return { ...body, id: `context-pack:${canonicalHash.slice(0, 32)}`, canonicalHash };
  }
}

async function verifyProviderAndRecentCache(input: ContextCompilerInput): Promise<void> {
  try {
    await verifyContextProviderCapabilityReceipt(input.provider.capabilityReceipt);
  } catch (error) {
    throw new ContextCompilerError("INVALID_CONTEXT_INPUT", `Context compiler rejected an invalid provider capability receipt: ${errorMessage(error)}`);
  }
  await verifyRecentConversationWindowHashes(input.recentConversationWindow);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recentConversationReceipt(
  input: ContextCompilerInput,
  sections: ContextPackBody["sections"]
): NonNullable<ContextPackBody["receipts"]["recentConversation"]> {
  const window = input.recentConversationWindow!;
  const included = new Set(
    sections
      .find((section) => section.kind === "history")!
      .entries.flatMap((entry) => (entry.id.startsWith("recent:") ? [entry.id.slice("recent:".length)] : []))
  );
  const selectedIds = window.entries
    .map((entry) => entry.id)
    .filter((id) => included.has(id))
    .sort();
  return {
    source: "bounded_derived_cache",
    cacheVersion: window.cacheVersion,
    canonicalStateAuthority: false,
    contentStored: false,
    candidateCount: window.entries.length,
    selectedIds,
    omittedCount: window.entries.length - selectedIds.length,
    entryHashes: window.entries.map(({ id, contentHash }) => ({ id, contentHash })).sort((left, right) => left.id.localeCompare(right.id))
  };
}

function selectedEntryIds(sections: ContextPackBody["sections"], kind: "memory" | "evidence"): string[] {
  return sections
    .find((section) => section.kind === kind)!
    .entries.map((entry) => entry.id)
    .sort();
}
