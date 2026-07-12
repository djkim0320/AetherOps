import type { EvidenceItem, Hypothesis, HypothesisStatus, ResearchQuestion, ResearchSnapshot } from "../shared/types.js";

export function normalizeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

export function hypothesisPromptRows(hypotheses: Hypothesis[]): Array<{ index: number; statement: string; status: HypothesisStatus; confidence: number }> {
  const rows: Array<{ index: number; statement: string; status: HypothesisStatus; confidence: number }> = [];
  for (let index = 0; index < hypotheses.length; index += 1) {
    const hypothesis = hypotheses[index];
    rows.push({
      index,
      statement: hypothesis.statement,
      status: hypothesis.status,
      confidence: hypothesis.confidence
    });
  }
  return rows;
}

export function latestValidationPromptRows(
  validations: ResearchSnapshot["validationResults"],
  limit: number
): Array<{
  hypothesisId?: string;
  status: string;
  confidence: number;
  reasoningSummary: string;
  limitations: string[];
  evidenceGaps: string[];
}> {
  const rows: Array<{
    hypothesisId?: string;
    status: string;
    confidence: number;
    reasoningSummary: string;
    limitations: string[];
    evidenceGaps: string[];
  }> = [];
  const start = Math.max(0, validations.length - limit);
  for (let index = start; index < validations.length; index += 1) {
    const result = validations[index];
    rows.push({
      hypothesisId: result.hypothesisId,
      status: result.status,
      confidence: result.confidence,
      reasoningSummary: result.reasoningSummary,
      limitations: limitedStrings(result.limitations, 4),
      evidenceGaps: limitedStrings(result.evidenceGaps, 4)
    });
  }
  return rows;
}

export function latestEvidenceCitationRows(
  evidence: EvidenceItem[],
  limit: number
): Array<{
  title: string;
  citation?: string;
  sourceUri?: string;
  reliabilityScore?: number;
  relevanceScore?: number;
  evidenceStrength?: EvidenceItem["evidenceStrength"];
  limitations?: string[];
}> {
  const rows: Array<{
    title: string;
    citation?: string;
    sourceUri?: string;
    reliabilityScore?: number;
    relevanceScore?: number;
    evidenceStrength?: EvidenceItem["evidenceStrength"];
    limitations?: string[];
  }> = [];
  const start = Math.max(0, evidence.length - limit);
  for (let index = start; index < evidence.length; index += 1) {
    const item = evidence[index];
    rows.push({
      title: item.title,
      citation: item.citation,
      sourceUri: item.sourceUri,
      reliabilityScore: item.reliabilityScore,
      relevanceScore: item.relevanceScore,
      evidenceStrength: item.evidenceStrength,
      limitations: optionalLimitedStrings(item.limitations, 3)
    });
  }
  return rows;
}

export function questionPromptRows(questions: ResearchQuestion[]): Array<{ index: number; text: string; status: string }> {
  const rows: Array<{ index: number; text: string; status: string }> = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    rows.push({ index, text: question.text.slice(0, 600), status: question.status });
  }
  return rows;
}

export function validationResultsForIteration(validations: ResearchSnapshot["validationResults"], iteration: number): ResearchSnapshot["validationResults"] {
  const rows: ResearchSnapshot["validationResults"] = [];
  for (const result of validations) {
    if (result.iteration === iteration) rows.push(result);
  }
  return rows;
}

export function selectedEvidencePromptRows(snapshot: ResearchSnapshot): Array<{
  title: string;
  citation?: string;
  sourceUri?: string;
  reliabilityScore?: number;
  relevanceScore?: number;
  evidenceStrength?: EvidenceItem["evidenceStrength"];
  limitations?: string[];
}> {
  const latestContext = snapshot.projectContextSnapshots.at(-1);
  if (!latestContext) return [];
  if (!latestContext.selectedEvidenceIds.length) return [];
  const selectedEvidenceIds = new Set(latestContext.selectedEvidenceIds);
  const rows: Array<{
    title: string;
    citation?: string;
    sourceUri?: string;
    reliabilityScore?: number;
    relevanceScore?: number;
    evidenceStrength?: EvidenceItem["evidenceStrength"];
    limitations?: string[];
  }> = [];
  for (const item of snapshot.evidence) {
    if (!selectedEvidenceIds.has(item.id)) continue;
    rows.push({
      title: item.title,
      citation: item.citation,
      sourceUri: item.sourceUri,
      reliabilityScore: item.reliabilityScore,
      relevanceScore: item.relevanceScore,
      evidenceStrength: item.evidenceStrength,
      limitations: optionalLimitedStrings(item.limitations, 3)
    });
  }
  return rows;
}

export function selectedChunkPromptRows(snapshot: ResearchSnapshot): Array<{ id: string; sourceId?: string; text: string; citation?: string }> {
  const latestContext = snapshot.projectContextSnapshots.at(-1);
  if (!latestContext) return [];
  if (!latestContext.selectedChunkIds.length) return [];
  const selectedChunkIds = new Set(latestContext.selectedChunkIds);
  const rows: Array<{ id: string; sourceId?: string; text: string; citation?: string }> = [];
  for (const chunk of snapshot.chunks) {
    if (!selectedChunkIds.has(chunk.id)) continue;
    rows.push({
      id: chunk.id,
      sourceId: chunk.sourceId,
      text: chunk.text.slice(0, 500),
      citation: chunk.citation
    });
    if (rows.length >= 12) break;
  }
  return rows;
}

export function legacyExecutionRunPromptRows(
  legacyAgentRuns: ResearchSnapshot["legacyAgentRuns"]
): Array<{ iteration: number; logs: string[]; toolPlan: string[] }> {
  const rows: Array<{ iteration: number; logs: string[]; toolPlan: string[] }> = [];
  for (const run of legacyAgentRuns) {
    rows.push({ iteration: run.iteration, logs: run.logs, toolPlan: run.toolPlan });
  }
  return rows;
}

export function projectContextPromptSummary(context: ResearchSnapshot["projectContextSnapshots"][number] | undefined): unknown {
  if (!context) return undefined;
  return {
    id: context.id,
    iteration: context.iteration,
    query: context.query.slice(0, 800),
    selectedRecordIds: context.selectedRecordIds.slice(0, 20),
    selectedSourceIds: context.selectedSourceIds.slice(0, 20),
    selectedEvidenceIds: context.selectedEvidenceIds.slice(0, 20),
    selectedChunkIds: context.selectedChunkIds.slice(0, 20),
    selectedEntityCount: context.selectedEntityIds.length,
    selectedRelationCount: context.selectedRelationIds.length,
    citations: limitedStrings(context.citations, 12),
    selectionReason: context.selectionReason.slice(0, 1_000)
  };
}

export function hybridContextPromptSummary(context: ResearchSnapshot["hybridContexts"][number] | undefined): unknown {
  if (!context) return undefined;
  return {
    id: context.id,
    iteration: context.iteration,
    query: context.query.slice(0, 800),
    evidenceIds: context.evidenceIds.slice(0, 20),
    artifactIds: context.artifactIds.slice(0, 20),
    vectorChunkCount: context.vectorChunkIds.length,
    ontologyEntityCount: context.ontologyEntityIds.length,
    ontologyRelationCount: context.ontologyRelationIds.length,
    citations: limitedStrings(context.citations, 12),
    vectorSummary: context.vectorSummary.slice(0, 1_500),
    graphSummary: context.graphSummary.slice(0, 1_500)
  };
}

export function toolRunPromptRows(
  toolRuns: ResearchSnapshot["toolRuns"],
  limit: number
): Array<{
  toolName: string;
  status: string;
  error?: string;
  outputSummary?: unknown;
}> {
  const rows: Array<{
    toolName: string;
    status: string;
    error?: string;
    outputSummary?: unknown;
  }> = [];
  const start = Math.max(0, toolRuns.length - limit);
  for (let index = start; index < toolRuns.length; index += 1) {
    const toolRun = toolRuns[index];
    rows.push({
      toolName: toolRun.toolName,
      status: toolRun.status,
      error: toolRun.error,
      outputSummary: summarizeToolOutput(toolRun.output)
    });
  }
  return rows;
}

function summarizeToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as Record<string, unknown>;
  if (Array.isArray(record.outputs)) {
    return {
      outputs: record.outputs.slice(0, 4).map((item) => summarizeProgramOutput(item))
    };
  }
  return summarizePlainObject(record, 12);
}

function summarizeProgramOutput(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const summary = record.summary && typeof record.summary === "object" ? (record.summary as Record<string, unknown>) : undefined;
  if (summary) {
    return {
      kind: record.kind,
      target: record.target,
      status: record.status,
      summary: {
        airfoil: summary.airfoil,
        runtime: summary.runtime,
        runtimeVersion: summary.runtimeVersion,
        runtimeLicense: summary.runtimeLicense,
        sourceKind: summary.sourceKind,
        sourceUrl: summary.sourceUrl,
        coordinateFormat: summary.coordinateFormat,
        reynolds: summary.reynolds,
        mach: summary.mach,
        alphaStart: summary.alphaStart,
        alphaEnd: summary.alphaEnd,
        alphaStep: summary.alphaStep,
        rowCount: summary.rowCount,
        rows: Array.isArray(summary.rows) ? summary.rows.slice(0, 24) : undefined,
        convergence: summary.convergence
      }
    };
  }
  return summarizePlainObject(record, 12);
}

function summarizePlainObject(record: Record<string, unknown>, limit: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).slice(0, limit)) {
    if (typeof value === "string") output[key] = value.slice(0, 1_000);
    else if (Array.isArray(value)) output[key] = value.slice(0, 12);
    else output[key] = value;
  }
  return output;
}

export function limitedStrings(values: string[] | undefined, limit: number): string[] {
  const output: string[] = [];
  if (!values) return output;
  const count = Math.min(values.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(values[index]);
  }
  return output;
}

function optionalLimitedStrings(values: string[] | undefined, limit: number): string[] | undefined {
  return values ? limitedStrings(values, limit) : undefined;
}
