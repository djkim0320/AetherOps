import { estimateContextTokens, type ContextBudgetAllocation } from "./contextBudget.js";
import { compareContextPriority, type PreparedContextCandidate } from "./contextCandidates.js";
import {
  CONTEXT_SECTION_ORDER,
  ContextCompilerError,
  type ContextArtifactHandle,
  type ContextPackBudgetReceipt,
  type ContextPackEntry,
  type ContextPackSection,
  type ContextPackSkill,
  type ContextPackTool,
  type ContextSectionKind,
  type ContextTruncationReceipt
} from "./contextTypes.js";

const SECTION_LABELS: Record<ContextSectionKind, string> = {
  task: "TASK",
  run_state: "RUN STATE",
  instructions: "INSTRUCTIONS",
  evidence: "EVIDENCE",
  memory: "MEMORY",
  skill: "SELECTED SKILL",
  tools: "TOOLS",
  artifacts: "ARTIFACTS",
  history: "PRIOR OUTPUT HANDLES"
};

export interface CompiledContextSections {
  sections: ContextPackSection[];
  providerInput: string;
  availableTools: ContextPackTool[];
  artifactHandles: ContextArtifactHandle[];
  selectedSkills: ContextPackSkill[];
  budget: ContextPackBudgetReceipt;
  truncations: ContextTruncationReceipt[];
}

export function compileContextSections(candidates: PreparedContextCandidate[], allocation: ContextBudgetAllocation): CompiledContextSections {
  const sections: ContextPackSection[] = [];
  const renderedSections: string[] = [];
  const includedCandidates: PreparedContextCandidate[] = [];
  const truncations: ContextTruncationReceipt[] = [];
  for (const kind of CONTEXT_SECTION_ORDER) {
    const sectionCandidates = candidates.filter((candidate) => candidate.section === kind).sort(compareContextPriority);
    const compiled = compileSection(kind, sectionCandidates, allocation, truncations);
    sections.push(compiled.section);
    includedCandidates.push(...compiled.includedCandidates);
    if (compiled.rendered) renderedSections.push(compiled.rendered);
  }
  const providerInput = renderedSections.join("\n\n");
  assertCriticalSections(sections);
  assertRequiredPolicyEntries(candidates, includedCandidates);
  const usedTokens = estimateContextTokens(providerInput);
  if (usedTokens > allocation.tokenBudget || providerInput.length > allocation.maxChars) {
    throw new ContextCompilerError("INVALID_CONTEXT_INPUT", "Compiled provider input exceeded its deterministic budget.");
  }
  return {
    sections,
    providerInput,
    availableTools: includedCandidates
      .flatMap((candidate) => (candidate.tool ? [candidate.tool] : []))
      .sort((left, right) => left.name.localeCompare(right.name)),
    artifactHandles: dedupeArtifactHandles(includedCandidates),
    selectedSkills: includedCandidates
      .flatMap((candidate) => (candidate.skill ? [candidate.skill] : []))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version)),
    budget: budgetReceipt(allocation, sections, usedTokens, providerInput.length),
    truncations
  };
}

function assertRequiredPolicyEntries(candidates: PreparedContextCandidate[], included: PreparedContextCandidate[]): void {
  const includedIds = new Set(included.map((candidate) => candidate.id));
  if (candidates.some((candidate) => candidate.section === "instructions" && candidate.trust === "system" && !includedIds.has(candidate.id))) {
    throw new ContextCompilerError("CONTEXT_BUDGET_EXHAUSTED", "The immutable system policy does not fit the context budget.");
  }
}

function compileSection(
  kind: ContextSectionKind,
  candidates: PreparedContextCandidate[],
  allocation: ContextBudgetAllocation,
  truncations: ContextTruncationReceipt[]
): { section: ContextPackSection; rendered: string; includedCandidates: PreparedContextCandidate[] } {
  const limits = allocation.sections[kind];
  const entries: ContextPackEntry[] = [];
  const includedCandidates: PreparedContextCandidate[] = [];
  let rendered = "";
  for (const candidate of candidates) {
    const existing = rendered;
    const full = renderedWithCandidate(kind, rendered, candidate.content, candidate);
    if (fits(full, limits.allocatedTokens, limits.allocatedChars)) {
      rendered = full;
      entries.push(packEntry(candidate));
      includedCandidates.push(candidate);
      continue;
    }
    const truncated = candidate.truncatable ? truncateToFit(kind, rendered, candidate, limits.allocatedTokens, limits.allocatedChars) : undefined;
    if (truncated) {
      rendered = truncated.rendered;
      entries.push({ ...packEntry(candidate), content: truncated.content });
      includedCandidates.push({ ...candidate, content: truncated.content });
    }
    truncations.push(truncationReceipt(kind, existing, candidate, limits.allocatedTokens, truncated));
  }
  return {
    section: {
      kind,
      requestedTokens: limits.requestedTokens,
      allocatedTokens: limits.allocatedTokens,
      usedTokens: estimateContextTokens(rendered),
      allocatedChars: limits.allocatedChars,
      usedChars: rendered.length,
      entries
    },
    rendered,
    includedCandidates
  };
}

function truncateToFit(
  kind: ContextSectionKind,
  existing: string,
  candidate: PreparedContextCandidate,
  tokenLimit: number,
  charLimit: number
): { content: string; rendered: string } | undefined {
  const codePoints = Array.from(candidate.content);
  let low = 0;
  let high = codePoints.length;
  let best: { content: string; rendered: string } | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const content = middle < codePoints.length ? `${codePoints.slice(0, middle).join("").trimEnd()}…` : codePoints.join("");
    const rendered = renderedWithCandidate(kind, existing, content, candidate);
    if (content && fits(rendered, tokenLimit, charLimit)) {
      best = { content, rendered };
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function truncationReceipt(
  section: ContextSectionKind,
  existing: string,
  candidate: PreparedContextCandidate,
  allocatedTokens: number,
  truncated: { content: string; rendered: string } | undefined
): ContextTruncationReceipt {
  const requested = renderedWithCandidate(section, existing, candidate.content, candidate);
  const usedTokens = truncated ? estimateContextTokens(truncated.rendered) - estimateContextTokens(existing) : 0;
  return {
    section,
    entryId: candidate.id,
    originalChars: candidate.content.length,
    includedChars: truncated?.content.length ?? 0,
    requestedTokens: estimateContextTokens(requested) - estimateContextTokens(existing),
    allocatedTokens: Math.max(0, allocatedTokens - estimateContextTokens(existing)),
    usedTokens,
    reason: "section_budget"
  };
}

function renderedWithCandidate(kind: ContextSectionKind, existing: string, content: string, candidate: PreparedContextCandidate): string {
  const marker = candidate.markers.length ? `;${candidate.markers.join(",")}` : "";
  const line = `[${candidate.trust}${marker}] ${renderCandidatePayload(candidate, content)}`;
  return existing ? `${existing}\n${line}` : `## ${SECTION_LABELS[kind]}\n${line}`;
}

function renderCandidatePayload(candidate: PreparedContextCandidate, content: string): string {
  return ["verified", "tool", "untrusted", "stale"].includes(candidate.trust)
    ? `DATA_ONLY_JSON=${JSON.stringify({ entryId: candidate.id, content })}`
    : content;
}

function packEntry(candidate: PreparedContextCandidate): ContextPackEntry {
  return {
    id: candidate.id,
    content: candidate.content,
    priority: candidate.priority,
    trust: candidate.trust,
    markers: [...candidate.markers],
    sourceRefs: [...candidate.sourceRefs],
    ...(candidate.artifactHandle ? { artifactHandle: candidate.artifactHandle } : {}),
    ...(candidate.tool ? { toolName: candidate.tool.name } : {}),
    ...(candidate.skill ? { skillId: candidate.skill.id } : {})
  };
}

function assertCriticalSections(sections: ContextPackSection[]): void {
  for (const kind of ["task", "run_state"] as const) {
    if (sections.find((section) => section.kind === kind)?.entries.length !== 1) {
      throw new ContextCompilerError("CONTEXT_BUDGET_EXHAUSTED", `The ${kind} section does not fit the context budget.`);
    }
  }
}

function fits(value: string, tokenLimit: number, charLimit: number): boolean {
  return value.length <= charLimit && estimateContextTokens(value) <= tokenLimit;
}

function dedupeArtifactHandles(candidates: PreparedContextCandidate[]): ContextArtifactHandle[] {
  const byHash = new Map<string, ContextArtifactHandle>();
  for (const candidate of candidates)
    if (candidate.artifactHandle && !byHash.has(candidate.artifactHandle.sha256)) byHash.set(candidate.artifactHandle.sha256, candidate.artifactHandle);
  return [...byHash.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.sha256.localeCompare(right.sha256));
}

function budgetReceipt(allocation: ContextBudgetAllocation, sections: ContextPackSection[], usedTokens: number, usedChars: number): ContextPackBudgetReceipt {
  const byKind = new Map(sections.map((section) => [section.kind, section]));
  const sectionReceipts = Object.fromEntries(
    CONTEXT_SECTION_ORDER.map((kind) => {
      const section = byKind.get(kind)!;
      return [
        kind,
        {
          requestedTokens: section.requestedTokens,
          allocatedTokens: section.allocatedTokens,
          usedTokens: section.usedTokens,
          allocatedChars: section.allocatedChars,
          usedChars: section.usedChars
        }
      ];
    })
  ) as ContextPackBudgetReceipt["sections"];
  return {
    tokenBudget: allocation.tokenBudget,
    usedTokens,
    maxChars: allocation.maxChars,
    usedChars,
    reservedSeparatorTokens: allocation.reservedSeparatorTokens,
    reservedSeparatorChars: allocation.reservedSeparatorChars,
    tokenEstimator: "utf8_bytes_upper_bound_v1",
    countingMethod: "utf16_code_units_v1",
    sections: sectionReceipts
  };
}
