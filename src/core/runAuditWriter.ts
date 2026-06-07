import { createId, nowIso } from "./ids.js";
import type { ProjectStorage } from "./projectStorage.js";
import type {
  BenchmarkPlan,
  ResearchDatabase,
  ResearchLoopStep,
  ResearchSnapshot,
  RunAuditOutput
} from "./types.js";

export class RunAuditWriter {
  constructor(private readonly storage: ProjectStorage) {}

  async write(snapshot: ResearchSnapshot, database: ResearchDatabase, failure?: { step?: ResearchLoopStep; reason?: string }): Promise<RunAuditOutput> {
    const output = buildRunAuditOutput(snapshot, failure);
    if (this.storage.writeRunAuditFiles) {
      const paths = await this.storage.writeRunAuditFiles(snapshot.project, database, output);
      return { ...output, reportPath: paths.reportPath, jsonPath: paths.jsonPath };
    }
    return output;
  }
}

export function buildRunAuditOutput(snapshot: ResearchSnapshot, failure?: { step?: ResearchLoopStep; reason?: string }): RunAuditOutput {
  const latestValidationLimit = Math.max(3, snapshot.hypotheses.length);
  const latestValidations = collectLastItems(snapshot.validationResults, latestValidationLimit);
  const evidenceGaps = collectEvidenceGaps(snapshot.continuationDecisions, latestValidations);
  const recoverableNextActions = buildRecoverableNextActions(snapshot, evidenceGaps);
  const completedIterations = findCompletedIterations(snapshot);
  const output: Omit<RunAuditOutput, "markdownReport"> = {
    id: createId("run-audit"),
    projectId: snapshot.project.id,
    finalStatus: snapshot.project.status,
    failedStep: failure?.step ?? snapshot.project.currentStep,
    failureReason: failure?.reason ?? snapshot.stepErrors.at(-1)?.message,
    completedIterations,
    sourceCount: snapshot.sources.length,
    evidenceCount: snapshot.evidence.length,
    artifactCount: snapshot.artifacts.length,
    chunkCount: snapshot.chunks.length,
    ontologyEntityCount: snapshot.ontologyEntities.length,
    ontologyRelationCount: snapshot.ontologyRelations.length,
    latestProjectContextSnapshotIds: collectLastIds(snapshot.projectContextSnapshots, 3),
    latestValidationResultIds: collectIds(latestValidations),
    latestResultIds: collectLastIds(snapshot.results, 3),
    continuationDecisionIds: collectIds(snapshot.continuationDecisions),
    evidenceGaps: collectFirstStrings(evidenceGaps, 24),
    recoverableNextActions,
    unmetRequirements: collectLastRuntimeRequirements(snapshot.runtimeBlockers, 12),
    createdAt: nowIso()
  };
  return {
    ...output,
    markdownReport: renderRunAuditMarkdown(snapshot, output)
  };
}

export function buildBenchmarkPlan(snapshot: ResearchSnapshot): BenchmarkPlan {
  const latestPlan = snapshot.researchPlans.at(-1);
  const queries: string[] = [];
  pushBenchmarkQuery(queries, latestPlan?.objective);
  for (const question of snapshot.questions) pushBenchmarkQuery(queries, question.text);
  for (const hypothesis of snapshot.hypotheses) pushBenchmarkQuery(queries, hypothesis.statement);
  return {
    id: createId("benchmark"),
    projectId: snapshot.project.id,
    queries: queries.length ? queries : [snapshot.project.topic],
    conditions: ["vector_only", "hybrid"],
    metrics: {
      citationCoverage: true,
      traceabilityPathCompleteness: true,
      unsupportedClaimDetection: true,
      evidenceGapRecall: true,
      latency: true,
      toolCostEstimate: true
    },
    createdAt: nowIso()
  };
}

function renderRunAuditMarkdown(snapshot: ResearchSnapshot, output: Omit<RunAuditOutput, "markdownReport">): string {
  const lines = [
    "# Research Run Audit",
    "",
    snapshot.project.status === "blocked"
      ? "**This is not a final research conclusion. The run was blocked before execution could proceed.**"
      : "**This is not a final research conclusion.**",
    "",
    "## Failure Summary",
    `- Project ID: ${output.projectId}`,
    `- Final status: ${output.finalStatus}`,
    `- Failed step: ${output.failedStep ?? "unknown"}`,
    `- Failure reason: ${output.failureReason ?? "No failure reason recorded."}`,
    `- Completed iterations: ${output.completedIterations}`,
    "",
    "## Memory Counts",
    `- Sources: ${output.sourceCount}`,
    `- Evidence: ${output.evidenceCount}`,
    `- Artifacts: ${output.artifactCount}`,
    `- Vector chunks: ${output.chunkCount}`,
    `- Ontology entities: ${output.ontologyEntityCount}`,
    `- Ontology relations: ${output.ontologyRelationCount}`,
    "",
    "## Latest Validation Results"
  ];
  appendLatestValidationLines(lines, snapshot.validationResults, 8);
  lines.push("", "## Continuation Decisions");
  appendLatestDecisionLines(lines, snapshot.continuationDecisions, 5);
  lines.push("", "## Evidence Gaps");
  appendBullets(lines, output.evidenceGaps, "No evidence gaps recorded.");
  lines.push("", "## Unmet Requirements");
  appendRequirementLines(lines, output.unmetRequirements);
  lines.push("", "## Recoverable Next Actions");
  appendBullets(lines, output.recoverableNextActions, "Inspect the failed step error and resume from the failed step after configuration/data repair.");
  lines.push(
    "",
    "## Benchmark Recommendation",
    "- Create a small Vector-only vs Hybrid benchmark with citation coverage, traceability path completeness, unsupported claim detection, evidence gap recall, latency, and tool cost estimate metrics.",
    ""
  );
  return lines.join("\n");
}

function collectEvidenceGaps(decisions: ResearchSnapshot["continuationDecisions"], validations: ResearchSnapshot["validationResults"]): string[] {
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const decision of decisions) {
    for (const gap of decision.evidenceGaps) {
      addUniqueString(gaps, seen, gap);
    }
  }
  for (const result of validations) {
    for (const gap of result.evidenceGaps) {
      addUniqueString(gaps, seen, gap);
    }
  }
  return gaps;
}

function findCompletedIterations(snapshot: ResearchSnapshot): number {
  let completedIterations = 0;
  for (const result of snapshot.results) {
    completedIterations = Math.max(completedIterations, result.iteration);
  }
  for (const result of snapshot.validationResults) {
    completedIterations = Math.max(completedIterations, result.iteration);
  }
  for (const context of snapshot.projectContextSnapshots) {
    completedIterations = Math.max(completedIterations, context.iteration);
  }
  return completedIterations;
}

function buildRecoverableNextActions(snapshot: ResearchSnapshot, evidenceGaps: string[]): string[] {
  const actions = new Set<string>();
  const latestDecision = snapshot.continuationDecisions.at(-1);
  for (const hint of latestDecision?.planRevisionHints ?? []) actions.add(hint);
  if (latestDecision?.fetchCandidateUrls?.length) {
    actions.add("Retry ExecuteTools with WebFetchTool using fetchCandidateUrls from the latest continuation decision.");
  }
  if (hasPdfSpanGap(evidenceGaps)) {
    actions.add("Run PdfIngestionTool on PDF source candidates to extract page/span-backed evidence.");
  }
  if (snapshot.stepErrors.at(-1)?.message.match(/timeout/i)) {
    actions.add("Retry the same LLM provider/model with compact planning context.");
  }
  const output: string[] = [];
  for (const action of actions) {
    output.push(action);
    if (output.length >= 12) break;
  }
  return output;
}

function collectLastItems<T>(items: T[], limit: number): T[] {
  const output: T[] = [];
  const start = Math.max(0, items.length - limit);
  for (let index = start; index < items.length; index += 1) {
    output.push(items[index]);
  }
  return output;
}

function collectIds(items: Array<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const item of items) ids.push(item.id);
  return ids;
}

function collectLastIds(items: Array<{ id: string }>, limit: number): string[] {
  const ids: string[] = [];
  const start = Math.max(0, items.length - limit);
  for (let index = start; index < items.length; index += 1) {
    ids.push(items[index].id);
  }
  return ids;
}

function collectFirstStrings(items: string[], limit: number): string[] {
  const output: string[] = [];
  const count = Math.min(items.length, limit);
  for (let index = 0; index < count; index += 1) {
    output.push(items[index]);
  }
  return output;
}

function collectLastRuntimeRequirements(
  blockers: ResearchSnapshot["runtimeBlockers"],
  limit: number
): NonNullable<RunAuditOutput["unmetRequirements"]> {
  const requirements: NonNullable<RunAuditOutput["unmetRequirements"]> = [];
  const start = Math.max(0, blockers.length - limit);
  for (let index = start; index < blockers.length; index += 1) {
    const blocker = blockers[index];
    requirements.push({
      requirementKey: blocker.requirementKey,
      message: blocker.message
    });
  }
  return requirements;
}

function addUniqueString(output: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || seen.has(value)) return;
  seen.add(value);
  output.push(value);
}

function appendLatestValidationLines(
  lines: string[],
  validations: ResearchSnapshot["validationResults"],
  limit: number
): void {
  const start = Math.max(0, validations.length - limit);
  for (let index = start; index < validations.length; index += 1) {
    const result = validations[index];
    lines.push(`- ${result.hypothesisId ?? "unknown"}: ${result.status} (${result.reasoningSummary})`);
  }
}

function appendLatestDecisionLines(
  lines: string[],
  decisions: ResearchSnapshot["continuationDecisions"],
  limit: number
): void {
  const start = Math.max(0, decisions.length - limit);
  for (let index = start; index < decisions.length; index += 1) {
    const decision = decisions[index];
    lines.push(`- Iteration ${decision.iteration}: shouldContinue=${decision.shouldContinue}; ${decision.reason}`);
  }
}

function appendBullets(lines: string[], items: string[], emptyMessage: string): void {
  if (!items.length) {
    lines.push(`- ${emptyMessage}`);
    return;
  }
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

function appendRequirementLines(lines: string[], requirements: RunAuditOutput["unmetRequirements"]): void {
  if (!requirements?.length) {
    lines.push("- No unmet runtime requirements recorded.");
    return;
  }
  for (const requirement of requirements) {
    lines.push(`- ${requirement.requirementKey}: ${requirement.message}`);
  }
}

function hasPdfSpanGap(evidenceGaps: string[]): boolean {
  for (const gap of evidenceGaps) {
    if (/pdf|span|page/i.test(gap)) return true;
  }
  return false;
}

function pushBenchmarkQuery(queries: string[], value: string | undefined): void {
  if (queries.length >= 8 || !value) return;
  queries.push(value);
}
