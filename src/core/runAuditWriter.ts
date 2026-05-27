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
  const latestContexts = snapshot.projectContextSnapshots.slice(-3);
  const latestValidations = snapshot.validationResults.slice(-Math.max(3, snapshot.hypotheses.length));
  const latestResults = snapshot.results.slice(-3);
  const evidenceGaps = [
    ...snapshot.continuationDecisions.flatMap((decision) => decision.evidenceGaps),
    ...latestValidations.flatMap((result) => result.evidenceGaps)
  ].filter(Boolean);
  const recoverableNextActions = buildRecoverableNextActions(snapshot, evidenceGaps);
  const completedIterations = Math.max(
    0,
    ...snapshot.results.map((result) => result.iteration),
    ...snapshot.validationResults.map((result) => result.iteration),
    ...snapshot.projectContextSnapshots.map((context) => context.iteration)
  );
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
    latestProjectContextSnapshotIds: latestContexts.map((context) => context.id),
    latestValidationResultIds: latestValidations.map((result) => result.id),
    latestResultIds: latestResults.map((result) => result.id),
    continuationDecisionIds: snapshot.continuationDecisions.map((decision) => decision.id),
    evidenceGaps: [...new Set(evidenceGaps)].slice(0, 24),
    recoverableNextActions,
    unmetRequirements: snapshot.runtimeBlockers.slice(-12).map((blocker) => ({
      requirementKey: blocker.requirementKey,
      message: blocker.message
    })),
    createdAt: nowIso()
  };
  return {
    ...output,
    markdownReport: renderRunAuditMarkdown(snapshot, output)
  };
}

export function buildBenchmarkPlan(snapshot: ResearchSnapshot): BenchmarkPlan {
  const latestPlan = snapshot.researchPlans.at(-1);
  const queries = [
    latestPlan?.objective,
    ...snapshot.questions.map((question) => question.text),
    ...snapshot.hypotheses.map((hypothesis) => hypothesis.statement)
  ].filter((item): item is string => Boolean(item)).slice(0, 8);
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
  return [
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
    "## Latest Validation Results",
    ...snapshot.validationResults.slice(-8).map((result) => `- ${result.hypothesisId ?? "unknown"}: ${result.status} (${result.reasoningSummary})`),
    "",
    "## Continuation Decisions",
    ...snapshot.continuationDecisions.slice(-5).map((decision) => `- Iteration ${decision.iteration}: shouldContinue=${decision.shouldContinue}; ${decision.reason}`),
    "",
    "## Evidence Gaps",
    ...(output.evidenceGaps.length ? output.evidenceGaps.map((gap) => `- ${gap}`) : ["- No evidence gaps recorded."]),
    "",
    "## Unmet Requirements",
    ...(output.unmetRequirements?.length
      ? output.unmetRequirements.map((requirement) => `- ${requirement.requirementKey}: ${requirement.message}`)
      : ["- No unmet runtime requirements recorded."]),
    "",
    "## Recoverable Next Actions",
    ...(output.recoverableNextActions.length ? output.recoverableNextActions.map((action) => `- ${action}`) : ["- Inspect the failed step error and resume from the failed step after configuration/data repair."]),
    "",
    "## Benchmark Recommendation",
    "- Create a small Vector-only vs Hybrid benchmark with citation coverage, traceability path completeness, unsupported claim detection, evidence gap recall, latency, and tool cost estimate metrics.",
    ""
  ].join("\n");
}

function buildRecoverableNextActions(snapshot: ResearchSnapshot, evidenceGaps: string[]): string[] {
  const actions = new Set<string>();
  const latestDecision = snapshot.continuationDecisions.at(-1);
  for (const hint of latestDecision?.planRevisionHints ?? []) actions.add(hint);
  if (latestDecision?.fetchCandidateUrls?.length) {
    actions.add("Retry ExecuteTools with WebFetchTool using fetchCandidateUrls from the latest continuation decision.");
  }
  if (evidenceGaps.some((gap) => /pdf|span|page/i.test(gap))) {
    actions.add("Run PdfIngestionTool on PDF source candidates to extract page/span-backed evidence.");
  }
  if (snapshot.stepErrors.at(-1)?.message.match(/timeout/i)) {
    actions.add("Retry the same LLM provider/model with compact planning context.");
  }
  return [...actions].slice(0, 12);
}
