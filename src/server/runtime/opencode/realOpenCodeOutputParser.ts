import { cleanString } from "./realOpenCodeCommon.js";

export interface OpenCodeArtifactSchema {
  title?: string;
  relativePath?: string;
  mimeType?: string;
  content?: string;
  summary?: string;
}

export interface OpenCodeSchema {
  summary?: string;
  toolPlan?: string[];
  artifacts?: OpenCodeArtifactSchema[];
  claims?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  sourceCandidates?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  nextActions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
}

export function parseOpenCodeJson(stdout: string): OpenCodeSchema | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return schemaFromParsed(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const schema = schemaFromParsed(JSON.parse(line));
        if (schema) return schema;
      } catch {
        const schema = schemaFromParsed(extractJsonObject(line));
        if (schema) return schema;
      }
    }
    return schemaFromParsed(extractJsonObject(trimmed));
  }
}

export function schemaFromParsed(parsed: unknown): OpenCodeSchema | undefined {
  if (typeof parsed === "string") {
    return schemaFromParsed(extractJsonObject(parsed));
  }
  if (!isRecord(parsed)) return undefined;

  const messageContent = extractNestedText(parsed.message, "content");
  if (messageContent) {
    const schema = schemaFromParsed(extractJsonObject(messageContent));
    if (schema) return schema;
  }

  const partText = extractNestedText(parsed.part, "text");
  if (partText) {
    const schema = schemaFromParsed(extractJsonObject(partText));
    if (schema) return schema;
  }

  const schema: OpenCodeSchema = {};
  let hasField = false;

  if (typeof parsed.summary === "string") {
    schema.summary = cleanString(parsed.summary);
    hasField = true;
  }

  const toolPlan = toStringArray(parsed.toolPlan);
  if (toolPlan) {
    schema.toolPlan = toolPlan;
    hasField = true;
  }

  const artifacts = toArtifactArray(parsed.artifacts);
  if (artifacts) {
    schema.artifacts = artifacts;
    hasField = true;
  }

  const claims = toRecordArray(parsed.claims);
  if (claims) {
    schema.claims = claims;
    hasField = true;
  }

  const observations = toRecordArray(parsed.observations);
  if (observations) {
    schema.observations = observations;
    hasField = true;
  }

  const sourceCandidates = toRecordArray(parsed.sourceCandidates);
  if (sourceCandidates) {
    schema.sourceCandidates = sourceCandidates;
    hasField = true;
  }

  const evidence = toRecordArray(parsed.evidence);
  if (evidence) {
    schema.evidence = evidence;
    hasField = true;
  }

  const nextActions = toStringArray(parsed.nextActions);
  if (nextActions) {
    schema.nextActions = nextActions;
    hasField = true;
  }

  if (typeof parsed.needsMoreEvidence === "boolean") {
    schema.needsMoreEvidence = parsed.needsMoreEvidence;
    hasField = true;
  }

  if (typeof parsed.needsMoreAnalysis === "boolean") {
    schema.needsMoreAnalysis = parsed.needsMoreAnalysis;
    hasField = true;
  }

  return hasField ? schema : undefined;
}

export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = cleanString(item);
      if (text) strings.push(text);
    }
  }
  return strings.length ? strings : undefined;
}

function toRecordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (isRecord(item)) records.push(item);
  }
  return records.length ? records : undefined;
}

function toArtifactArray(value: unknown): OpenCodeArtifactSchema[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const artifacts: OpenCodeArtifactSchema[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const artifact: OpenCodeArtifactSchema = {};
    let hasField = false;
    if (typeof item.title === "string") {
      artifact.title = cleanString(item.title);
      hasField = true;
    }
    if (typeof item.relativePath === "string") {
      artifact.relativePath = cleanString(item.relativePath);
      hasField = true;
    }
    if (typeof item.mimeType === "string") {
      artifact.mimeType = cleanString(item.mimeType);
      hasField = true;
    }
    if (typeof item.content === "string") {
      artifact.content = cleanString(item.content);
      hasField = true;
    }
    if (typeof item.summary === "string") {
      artifact.summary = cleanString(item.summary);
      hasField = true;
    }
    if (hasField) artifacts.push(artifact);
  }
  return artifacts.length ? artifacts : undefined;
}

function extractNestedText(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return typeof nested === "string" ? cleanString(nested) : undefined;
}
