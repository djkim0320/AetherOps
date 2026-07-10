export const CODEX_MODEL_IDS = [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark"
] as const;

export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export type CodexModelCategory = "recommended" | "compatibility" | "experimental";

export interface CodexModelDescriptor {
  readonly id: CodexModelId;
  readonly label: string;
  readonly category: CodexModelCategory;
  readonly description: string;
  readonly experimental: boolean;
  readonly entitlement?: string;
  readonly supportedReasoningEfforts: readonly CodexReasoningEffort[];
}

export interface CodexSettingsValue {
  readonly model: CodexModelId;
  readonly reasoningEffort: CodexReasoningEffort;
  readonly timeoutMs: number;
}

const STANDARD_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const GPT_56_EFFORTS = [...STANDARD_EFFORTS, "max"] as const;

export const CODEX_MODEL_CATALOG: readonly CodexModelDescriptor[] = [
  descriptor("gpt-5.6", "GPT-5.6", "recommended", "Recommended rolling alias for Codex orchestration.", GPT_56_EFFORTS),
  descriptor("gpt-5.6-sol", "GPT-5.6 Sol", "recommended", "Explicit GPT-5.6 Sol model.", GPT_56_EFFORTS),
  descriptor("gpt-5.6-terra", "GPT-5.6 Terra", "recommended", "Explicit GPT-5.6 Terra model.", GPT_56_EFFORTS),
  descriptor("gpt-5.6-luna", "GPT-5.6 Luna", "recommended", "Explicit GPT-5.6 Luna model.", GPT_56_EFFORTS),
  descriptor("gpt-5.5", "GPT-5.5", "compatibility", "Compatibility model for existing Codex workflows.", STANDARD_EFFORTS),
  descriptor("gpt-5.4", "GPT-5.4", "compatibility", "Compatibility model for established Codex workflows.", STANDARD_EFFORTS),
  descriptor("gpt-5.4-mini", "GPT-5.4 mini", "compatibility", "Smaller compatibility model for bounded tasks.", STANDARD_EFFORTS),
  descriptor(
    "gpt-5.3-codex-spark",
    "GPT-5.3 Codex Spark",
    "experimental",
    "Text-only research preview for eligible ChatGPT Pro accounts.",
    STANDARD_EFFORTS,
    "ChatGPT Pro"
  )
] as const;

export const DEFAULT_CODEX_MODEL: CodexModelId = "gpt-5.6";
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "xhigh";
export const DEFAULT_CODEX_TIMEOUT_MS = 180_000;

const modelIds = new Set<string>(CODEX_MODEL_IDS);
const effortIds = new Set<string>(CODEX_REASONING_EFFORTS);
const descriptorById = new Map<CodexModelId, CodexModelDescriptor>(CODEX_MODEL_CATALOG.map((item) => [item.id, item]));

export function isCodexModelId(value: unknown): value is CodexModelId {
  return typeof value === "string" && modelIds.has(value);
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && effortIds.has(value);
}

export function getCodexModelDescriptor(model: CodexModelId): CodexModelDescriptor {
  const value = descriptorById.get(model);
  if (!value) throw new Error(`Unsupported Codex model: ${model}`);
  return value;
}

export function isCodexModelEffortCompatible(model: CodexModelId, effort: CodexReasoningEffort): boolean {
  return getCodexModelDescriptor(model).supportedReasoningEfforts.includes(effort);
}

export function assertCodexSettings(value: unknown): asserts value is CodexSettingsValue {
  if (!value || typeof value !== "object") throw new Error("Codex settings must be an object.");
  const candidate = value as Record<string, unknown>;
  if (!isCodexModelId(candidate.model)) throw new Error(`Unsupported Codex model: ${String(candidate.model)}`);
  if (!isCodexReasoningEffort(candidate.reasoningEffort)) throw new Error(`Unsupported Codex reasoning effort: ${String(candidate.reasoningEffort)}`);
  if (!isCodexModelEffortCompatible(candidate.model, candidate.reasoningEffort)) {
    throw new Error(`${candidate.reasoningEffort} is not supported by ${candidate.model}`);
  }
  if (!Number.isInteger(candidate.timeoutMs) || Number(candidate.timeoutMs) < 1_000 || Number(candidate.timeoutMs) > 900_000) {
    throw new Error("Codex timeoutMs must be an integer between 1000 and 900000.");
  }
}

function descriptor(
  id: CodexModelId,
  label: string,
  category: CodexModelCategory,
  description: string,
  supportedReasoningEfforts: readonly CodexReasoningEffort[],
  entitlement?: string
): CodexModelDescriptor {
  return { id, label, category, description, experimental: category === "experimental", entitlement, supportedReasoningEfforts };
}
