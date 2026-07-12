import { createHash } from "node:crypto";
import { extractJsonObject, type LlmInvocationMetadata, type LlmJsonRequest } from "../../../core/providers/llm.js";
import { normalizeCodexOutputValue } from "./codexOutputSchema.js";

export function formatParseError(error: unknown): string {
  const issues = zodIssues(error);
  return issues.length ? issues.join("; ") : error instanceof Error ? error.message : String(error);
}

export function safeValidationError(error: unknown): string {
  return formatParseError(error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 2_000);
}

export function attachInvocationMetadata(error: unknown, metadata: LlmInvocationMetadata): void {
  if (!error || typeof error !== "object") return;
  Object.defineProperty(error, "llmInvocationMetadata", { value: metadata, configurable: true });
}

export function parseAndValidateResponse<T>(request: LlmJsonRequest<T>, text: string): T {
  const parsed = extractJsonObject(text);
  return request.schema ? request.schema.parse(normalizeCodexOutputValue(parsed)) : (parsed as T);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function zodIssues(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("issues" in error) || !Array.isArray(error.issues)) return [];
  return error.issues.flatMap((issue) => summarizeIssue(issue)).slice(0, 24);
}

function summarizeIssue(issue: unknown, prefix: Array<string | number> = []): string[] {
  if (!issue || typeof issue !== "object") return [];
  const value = issue as { code?: unknown; path?: unknown; message?: unknown; errors?: unknown };
  const path = [
    ...prefix,
    ...(Array.isArray(value.path) ? value.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number") : [])
  ];
  if (value.code === "invalid_union" && Array.isArray(value.errors)) {
    const branches = value.errors.filter(Array.isArray) as unknown[][];
    const matching = branches.find((branch) => !branch.some((entry) => hasPathSegment(entry, "toolName")));
    const selected = matching ?? [...branches].sort((left, right) => left.length - right.length)[0] ?? [];
    return selected.flatMap((entry) => summarizeIssue(entry, path));
  }
  const location = path.length ? path.join(".") : "response";
  return [`${location}: ${typeof value.message === "string" ? value.message : "Invalid value"}`];
}

function hasPathSegment(issue: unknown, segment: string): boolean {
  return Boolean(issue && typeof issue === "object" && "path" in issue && Array.isArray(issue.path) && issue.path.includes(segment));
}
