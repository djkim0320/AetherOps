import { createId, nowIso } from "../shared/ids.js";
import type { EvidenceItem, ResearchToolInput, ToolRun, ValidationResult } from "../shared/types.js";
import { getToolDescriptor } from "./toolDescriptors.js";
import type { ResearchTool, ResearchToolExecutionContext, ResearchToolResult } from "./researchToolTypes.js";

export type AnalysisCheck =
  "source_scope" | "evidence_coverage" | "question_coverage" | "hypothesis_coverage" | "engineering_fidelity" | "artifact_completeness";

interface CheckAssessment {
  check: AnalysisCheck;
  status: "satisfied" | "partial" | "unverifiable";
  findings: string[];
  gaps: string[];
}

export class DataAnalysisTool implements ResearchTool {
  name = "DataAnalysisTool";

  async run(input: ResearchToolInput, _settings?: unknown, context?: ResearchToolExecutionContext): Promise<ResearchToolResult> {
    const startedAt = nowIso();
    const toolInput = validatedInputs(context);
    const evidence = input.evidence ?? [];
    const normalizedRecords = input.normalizedRecords ?? [];
    const supportEligibleEvidenceIds = supportEligibleIds(normalizedRecords);
    const citationCoverage = evidence.length ? evidence.filter(hasCitation).length / evidence.length : 0;
    const latestValidation = latestValidations(input.validationResults ?? []);
    const assessments = toolInput.checks.map((check) => assess(check, input, evidence, supportEligibleEvidenceIds));
    const evidenceGaps = unique([...assessments.flatMap((item) => item.gaps), ...latestValidation.flatMap((item) => item.evidenceGaps)]);
    const output = {
      checks: toolInput.checks,
      checkAssessments: assessments,
      questionAssessments: input.questions.map((question) => questionAssessment(question.id, evidence)),
      hypothesisAssessments: input.hypotheses.map((hypothesis) => hypothesisAssessment(hypothesis.id, evidence, latestValidation)),
      engineeringChecks: engineeringChecks(input.toolRuns ?? []),
      evidenceCount: evidence.length,
      supportEligibleEvidenceCount: supportEligibleEvidenceIds.size,
      citationCoverage,
      sourceQualityDistribution: distribution(evidence.map((item) => sourceQuality(item))),
      traceabilityKindDistribution: distribution(normalizedRecords.map((record) => stringValue(record.metadata.traceabilityKind, "unknown"))),
      hypothesisEvidenceCoverage: Object.fromEntries(
        input.hypotheses.map((hypothesis) => {
          const linked = evidence.filter((item) => item.linkedHypothesisIds.includes(hypothesis.id));
          return [
            hypothesis.id,
            {
              linkedEvidenceCount: linked.length,
              supportEligibleEvidenceCount: linked.filter((item) => supportEligibleEvidenceIds.has(item.id)).length
            }
          ];
        })
      ),
      validationStatusDistribution: distribution((input.validationResults ?? []).map((item) => item.status)),
      evidenceGaps,
      planRevisionHints: evidenceGaps.map((gap) => `Collect or validate evidence for: ${gap}`),
      inputAvailability: {
        normalizedRecordCount: normalizedRecords.length,
        validationResultCount: input.validationResults?.length ?? 0,
        projectContextSnapshotCount: input.projectContextSnapshots?.length ?? 0,
        resultCount: input.results?.length ?? 0
      }
    };
    const completedAt = nowIso();
    return {
      toolRun: completedToolRun(input, startedAt, completedAt, toolInput, output),
      evidence: [],
      artifacts: [],
      sources: []
    };
  }
}

function validatedInputs(context: ResearchToolExecutionContext | undefined): { checks: AnalysisCheck[] } {
  if (!context) throw new Error("DataAnalysisTool requires validated execution context inputs.");
  const descriptor = getToolDescriptor("DataAnalysisTool");
  if (!descriptor) throw new Error("DataAnalysisTool descriptor is not registered.");
  return descriptor.inputSchema.parse(context.inputs) as { checks: AnalysisCheck[] };
}

function supportEligibleIds(records: NonNullable<ResearchToolInput["normalizedRecords"]>): Set<string> {
  return new Set(
    records
      .filter(
        (record) =>
          record.kind === "evidence" &&
          record.evidenceId &&
          record.metadata.canSupportHypothesis === true &&
          ["external_source", "tool_observation"].includes(String(record.metadata.traceabilityKind)) &&
          !["weak", "excluded", "general_web"].includes(String(record.metadata.sourceQualityTier))
      )
      .map((record) => record.evidenceId as string)
  );
}

function assess(check: AnalysisCheck, input: ResearchToolInput, evidence: EvidenceItem[], supportEligible: Set<string>): CheckAssessment {
  if (check === "source_scope") {
    const policy = input.executionContext?.toolPolicy.sourceAccess;
    if (!policy) return assessment(check, "unverifiable", [], ["Job source policy was not available."]);
    const outside = (input.sources ?? []).filter((source) => typeof source.url === "string" && !sourceAllowed(source.url, policy));
    return outside.length
      ? assessment(
          check,
          "partial",
          [],
          outside.map((source) => `Source is outside policy: ${source.url}`)
        )
      : assessment(check, "satisfied", [`${input.sources?.length ?? 0} sources satisfy the job policy.`], []);
  }
  if (check === "evidence_coverage") {
    if (!evidence.length) return assessment(check, "unverifiable", [], ["No evidence was collected."]);
    const cited = evidence.filter(hasCitation).length;
    return assessment(
      check,
      cited === evidence.length ? "satisfied" : "partial",
      [`${cited}/${evidence.length} evidence rows are cited.`],
      cited === evidence.length ? [] : ["Citation coverage is incomplete."]
    );
  }
  if (check === "question_coverage") {
    const covered = input.questions.filter((question) => evidence.some((item) => linkedQuestionIds(item).includes(question.id))).length;
    return assessment(
      check,
      covered === input.questions.length && covered > 0 ? "satisfied" : covered ? "partial" : "unverifiable",
      [`${covered}/${input.questions.length} questions have explicit evidence links.`],
      covered === input.questions.length ? [] : ["One or more questions lack explicitly linked evidence."]
    );
  }
  if (check === "hypothesis_coverage") {
    const covered = input.hypotheses.filter((hypothesis) =>
      evidence.some((item) => item.linkedHypothesisIds.includes(hypothesis.id) && supportEligible.has(item.id))
    ).length;
    return assessment(
      check,
      covered === input.hypotheses.length && covered > 0 ? "satisfied" : covered ? "partial" : "unverifiable",
      [`${covered}/${input.hypotheses.length} hypotheses have support-eligible evidence.`],
      covered === input.hypotheses.length ? [] : ["One or more hypotheses lack support-eligible evidence."]
    );
  }
  if (check === "engineering_fidelity") {
    const runs = engineeringChecks(input.toolRuns ?? []);
    if (!runs.length) return assessment(check, "unverifiable", [], ["No engineering tool run was available."]);
    const invalid = runs.filter((item) => item.status !== "valid");
    return assessment(
      check,
      invalid.length ? "partial" : "satisfied",
      [`${runs.length - invalid.length}/${runs.length} engineering runs completed with grounded inputs.`],
      invalid.flatMap((item) => item.gaps)
    );
  }
  const artifactCount = input.artifacts?.length ?? 0;
  return assessment(
    check,
    artifactCount ? "satisfied" : "unverifiable",
    [`${artifactCount} artifacts are available.`],
    artifactCount ? [] : ["No artifact was available for completeness validation."]
  );
}

function assessment(check: AnalysisCheck, status: CheckAssessment["status"], findings: string[], gaps: string[]): CheckAssessment {
  return { check, status, findings, gaps };
}

function questionAssessment(questionId: string, evidence: EvidenceItem[]) {
  const evidenceIds = evidence.filter((item) => linkedQuestionIds(item).includes(questionId)).map((item) => item.id);
  return {
    questionId,
    status: evidenceIds.length ? "answered" : "unanswered",
    evidenceIds,
    gaps: evidenceIds.length ? [] : ["No explicitly linked evidence."]
  };
}

function hypothesisAssessment(hypothesisId: string, evidence: EvidenceItem[], validations: ValidationResult[]) {
  const validation = validations.find((item) => item.hypothesisId === hypothesisId);
  const linked = evidence.filter((item) => item.linkedHypothesisIds.includes(hypothesisId)).map((item) => item.id);
  return {
    hypothesisId,
    status: validation ? validation.status : "inconclusive",
    supportingEvidenceIds: validation?.supportingEvidenceIds ?? linked,
    contradictingEvidenceIds: validation?.contradictingEvidenceIds ?? [],
    confidence: validation?.confidence ?? 0,
    limitations: validation?.limitations ?? (linked.length ? [] : ["No linked evidence was available."])
  };
}

function engineeringChecks(runs: ToolRun[]) {
  return runs
    .filter((run) => run.toolName === "EngineeringProgramTool")
    .map((run) => ({
      toolRunId: run.id,
      status: run.status === "completed" && Boolean(run.input) && Boolean(run.output) ? ("valid" as const) : ("invalid" as const),
      gaps: run.status === "completed" && run.input && run.output ? [] : ["Engineering run was incomplete or lacked grounded input/output."],
      inputHashEligible: Boolean(run.input),
      outputPresent: Boolean(run.output)
    }));
}

function latestValidations(values: ValidationResult[]): ValidationResult[] {
  const iteration = Math.max(0, ...values.map((item) => item.iteration));
  return values.filter((item) => item.iteration === iteration);
}

function linkedQuestionIds(item: EvidenceItem): string[] {
  const value = item.metadata?.linkedQuestionIds;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function hasCitation(item: EvidenceItem): boolean {
  return Boolean(item.citation || item.quote || item.sourceUri);
}

function sourceQuality(item: EvidenceItem): string {
  return item.keywords.find((keyword) => ["scholarly", "official", "institutional", "general_web", "weak", "excluded"].includes(keyword)) ?? "unknown";
}

function sourceAllowed(url: string, policy: NonNullable<ResearchToolInput["executionContext"]>["toolPolicy"]["sourceAccess"]): boolean {
  if (policy.mode === "offline") return false;
  const host = new URL(url).hostname.toLowerCase();
  if (policy.mode === "allowlist") return policy.urls.includes(url);
  return !policy.allowedDomains.length || policy.allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function distribution(values: string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function completedToolRun(input: ResearchToolInput, startedAt: string, completedAt: string, toolInput: unknown, output: unknown): ToolRun {
  return {
    id: createId("tool"),
    projectId: input.project.id,
    iteration: input.iteration,
    toolName: "DataAnalysisTool",
    input: toolInput,
    output,
    status: "completed",
    startedAt,
    completedAt
  };
}
