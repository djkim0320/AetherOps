import type { ToolRun } from "../shared/types.js";
import type { ResearchToolResult } from "./researchToolTypes.js";

export type ResearchToolResultValidation = { ok: true; result: ResearchToolResult } | { ok: false; message: string };

const toolRunStringFields = ["id", "projectId", "toolName", "startedAt", "completedAt"] as const;
const validToolRunStatuses = new Set<ToolRun["status"]>(["completed", "failed", "skipped"]);

export function validateResearchToolResult(value: unknown): ResearchToolResultValidation {
  const message = invalidResearchToolResultReason(value);
  if (message) return { ok: false, message };
  return { ok: true, result: value as ResearchToolResult };
}

function invalidResearchToolResultReason(value: unknown): string | undefined {
  if (!isRecord(value)) return "result must be an object";
  const toolRun = value.toolRun;
  if (!isRecord(toolRun)) return "toolRun must be an object";
  for (const field of toolRunStringFields) {
    if (typeof toolRun[field] !== "string") return `toolRun.${field} must be a string`;
  }
  if (typeof toolRun.iteration !== "number" || !Number.isFinite(toolRun.iteration)) {
    return "toolRun.iteration must be a finite number";
  }
  if (!isToolRunStatus(toolRun.status)) return "toolRun.status must be completed, failed, or skipped";
  if (!hasOwn(toolRun, "input")) return "toolRun.input is required";
  if (!hasOwn(toolRun, "output")) return "toolRun.output is required";
  if (!Array.isArray(value.evidence)) return "evidence must be an array";
  if (!Array.isArray(value.artifacts)) return "artifacts must be an array";
  if (!Array.isArray(value.sources)) return "sources must be an array";
  const evidenceMessage = invalidArrayItemReason(value.evidence, "evidence", invalidEvidenceItemReason);
  if (evidenceMessage) return evidenceMessage;
  const artifactMessage = invalidArrayItemReason(value.artifacts, "artifacts", invalidArtifactItemReason);
  if (artifactMessage) return artifactMessage;
  const sourceMessage = invalidArrayItemReason(value.sources, "sources", invalidSourceItemReason);
  if (sourceMessage) return sourceMessage;
  return undefined;
}

function invalidArrayItemReason(items: unknown[], field: string, validate: (value: unknown) => string | undefined): string | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const message = validate(items[index]);
    if (message) return `${field}[${index}].${message}`;
  }
  return undefined;
}

function invalidEvidenceItemReason(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object";
  for (const field of ["id", "projectId", "category", "title", "summary", "createdAt"] as const) {
    if (typeof value[field] !== "string") return `${field} must be a string`;
  }
  if (!Array.isArray(value.keywords) || !value.keywords.every((item) => typeof item === "string")) {
    return "keywords must be a string array";
  }
  if (!Array.isArray(value.linkedHypothesisIds) || !value.linkedHypothesisIds.every((item) => typeof item === "string")) {
    return "linkedHypothesisIds must be a string array";
  }
  for (const field of ["reliabilityScore", "relevanceScore"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) {
      return `${field} must be a finite number when present`;
    }
  }
  return undefined;
}

function invalidArtifactItemReason(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object";
  for (const field of ["id", "projectId", "category", "title", "relativePath", "mimeType", "summary", "createdAt"] as const) {
    if (typeof value[field] !== "string") return `${field} must be a string`;
  }
  return undefined;
}

function invalidSourceItemReason(value: unknown): string | undefined {
  if (!isRecord(value)) return "must be an object";
  for (const field of ["id", "projectId", "kind", "title", "retrievedAt"] as const) {
    if (typeof value[field] !== "string") return `${field} must be a string`;
  }
  if (!isRecord(value.metadata)) return "metadata must be an object";
  if (value.createdAt !== undefined && typeof value.createdAt !== "string") return "createdAt must be a string when present";
  return undefined;
}

function isToolRunStatus(value: unknown): value is ToolRun["status"] {
  return typeof value === "string" && validToolRunStatuses.has(value as ToolRun["status"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
