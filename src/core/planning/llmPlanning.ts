import { createId, nowIso } from "../shared/ids.js";
import type { LlmProvider } from "../providers/llm.js";
import {
  hybridContextPromptSummary,
  hypothesisPromptRows,
  latestEvidenceCitationRows,
  latestValidationPromptRows,
  limitedStrings,
  normalizeArray,
  legacyExecutionRunPromptRows,
  projectContextPromptSummary,
  questionPromptRows,
  selectedChunkPromptRows,
  selectedEvidencePromptRows,
  toolRunPromptRows,
  validationResultsForIteration
} from "./llmResultPrompts.js";
import {
  buildSeedEvidence,
  buildSeedHypotheses,
  buildSeedQuestions,
  clampConfidence,
  cleanText,
  collectCleanStrings,
  type LlmSeedResponse,
  normalizeStatus
} from "./llmSeedBuilders.js";
import type { EvidenceBasedResult, EvidenceItem, Hypothesis, HypothesisStatus, ResearchProject, ResearchQuestion, ResearchSnapshot } from "../shared/types.js";

interface LlmResultResponse {
  answer?: string;
  finalAnswer?: string;
  summary?: string;
  hypothesisUpdates?: Array<{
    hypothesisIndex: number;
    status: HypothesisStatus;
    confidence: number;
    rationale: string;
  }>;
  quantitativeResults?: string[];
  qualitativeResults?: string[];
  nextQuestions?: string[];
  needsMoreEvidence?: boolean;
  needsMoreAnalysis?: boolean;
}

export async function generateSeedPlanWithLlm(
  llm: LlmProvider,
  project: ResearchProject
): Promise<
  | {
      questions: ResearchQuestion[];
      hypotheses: Hypothesis[];
      evidence: EvidenceItem[];
    }
  | undefined
> {
  if (!(await llm.isAvailable())) {
    return undefined;
  }

  const response = await llm.completeJson<LlmSeedResponse>({
    schemaName: "AetherOpsSeedResearchPlan",
    system: "You are AetherOps, a Korean autonomous research planning agent. Return only valid JSON.",
    user: [
      "Create initial research questions, hypotheses, and seed evidence for this project.",
      "Create 3 to 5 focused questions.",
      "Hypotheses must be testable and tied to a question.",
      "Seed evidence is only a planning memo unless it has citation/sourceUri. Do not pretend it is a paper or external source.",
      "For uncertain claims, include limitations and low reliabilityScore.",
      "Return JSON with keys: questions, hypotheses, evidence.",
      "questions: array of { text }.",
      "hypotheses: array of { questionIndex, statement, confidence } using zero-based questionIndex.",
      "evidence: array of { category, title, summary, sourceUri, citation, quote, reliabilityScore, relevanceScore, evidenceStrength, limitations, keywords, hypothesisIndexes }.",
      "Allowed categories: generated_artifact, paper_reference, web_source, experiment_log, conversation_memo.",
      "",
      `Goal: ${project.goal}`,
      `Topic: ${project.topic}`,
      `Scope: ${project.scope}`,
      `Budget: ${project.budget}`,
      `Autonomy: ${JSON.stringify(project.autonomyPolicy)}`
    ].join("\n"),
    timeoutMs: 180_000
  });

  const createdAt = nowIso();
  const questions = buildSeedQuestions(response.questions, project, createdAt);

  if (questions.length < 3) {
    return undefined;
  }

  const hypotheses = buildSeedHypotheses(response.hypotheses, project, questions, createdAt);
  const evidence = buildSeedEvidence(response.evidence, project, hypotheses, createdAt);

  return {
    questions,
    hypotheses,
    evidence
  };
}

export async function deriveResultWithLlm(
  llm: LlmProvider,
  snapshot: ResearchSnapshot,
  iteration: number,
  forceStop: boolean
): Promise<EvidenceBasedResult | undefined> {
  if (!(await llm.isAvailable())) {
    return undefined;
  }

  let response = await requestResultJson(llm, snapshot, iteration, forceStop);
  let answer = cleanText(response.answer ?? response.finalAnswer ?? response.summary);
  if (!answer) {
    response = await requestResultJson(llm, snapshot, iteration, forceStop, true);
    answer = cleanText(response.answer ?? response.finalAnswer ?? response.summary);
  }

  const createdAt = nowIso();
  if (!answer) {
    return undefined;
  }
  const hypothesisUpdates: EvidenceBasedResult["hypothesisUpdates"] = [];
  for (const update of normalizeArray(response.hypothesisUpdates)) {
    const hypothesis = snapshot.hypotheses[update.hypothesisIndex];
    if (!hypothesis) continue;
    hypothesisUpdates.push({
      hypothesisId: hypothesis.id,
      status: normalizeStatus(update.status),
      confidence: clampConfidence(update.confidence),
      rationale: cleanText(update.rationale) || "LLM derived update without detailed rationale."
    });
  }

  return {
    id: createId("result"),
    projectId: snapshot.project.id,
    iteration,
    answer,
    hypothesisUpdates,
    quantitativeResults: collectCleanStrings(response.quantitativeResults),
    qualitativeResults: collectCleanStrings(response.qualitativeResults),
    nextQuestions: forceStop ? [] : collectCleanStrings(response.nextQuestions, 5),
    needsMoreEvidence: forceStop ? false : Boolean(response.needsMoreEvidence),
    needsMoreAnalysis: forceStop ? false : Boolean(response.needsMoreAnalysis),
    createdAt
  };
}

function requestResultJson(llm: LlmProvider, snapshot: ResearchSnapshot, iteration: number, forceStop: boolean, repair = false): Promise<LlmResultResponse> {
  const user = repair
    ? [
        "The previous response omitted a non-empty answer. Produce a concise evidence-based JSON result now.",
        "Return JSON with keys: answer, hypothesisUpdates, quantitativeResults, qualitativeResults, nextQuestions, needsMoreEvidence, needsMoreAnalysis.",
        "answer is required and must be a non-empty Korean string.",
        "hypothesisUpdates uses zero-based hypothesisIndex and status among supported, rejected, needs_more_evidence, untested.",
        forceStop
          ? "The internal runaway-prevention safety cap has been reached; synthesize cautiously, set needsMoreEvidence=false, needsMoreAnalysis=false, and list unresolved limits instead of requesting another loop."
          : "",
        `Project: ${JSON.stringify({
          topic: snapshot.project.topic,
          goal: snapshot.project.goal.slice(0, 1_200)
        })}`,
        `Hypotheses: ${JSON.stringify(hypothesisPromptRows(snapshot.hypotheses))}`,
        `ValidationResults: ${JSON.stringify(latestValidationPromptRows(snapshot.validationResults, 8))}`,
        `EvidenceCitations: ${JSON.stringify(latestEvidenceCitationRows(snapshot.evidence, 12))}`,
        `HybridCitations: ${JSON.stringify(limitedStrings(snapshot.hybridContexts.at(-1)?.citations, 12))}`
      ].join("\n")
    : [
        "Derive an evidence-based research result from the current project state.",
        "Use only evidence and RAG context. Treat evidence without citation/sourceUri/sourceId as low reliability.",
        "Every hypothesis update must include a concrete rationale grounded in evidence or an explicit evidence_gap.",
        "Separate quantitativeResults and qualitativeResults.",
        "If this is the final iteration, do not force certainty; state limitations and additional research needs.",
        "Return JSON with keys: answer, hypothesisUpdates, quantitativeResults, qualitativeResults, nextQuestions, needsMoreEvidence, needsMoreAnalysis.",
        "hypothesisUpdates uses zero-based hypothesisIndex and status among supported, rejected, needs_more_evidence, untested.",
        forceStop
          ? "The internal runaway-prevention safety cap has been reached; synthesize cautiously, set needsMoreEvidence=false, needsMoreAnalysis=false, and list unresolved limits instead of requesting another loop."
          : "",
        "",
        `Project: ${JSON.stringify({
          topic: snapshot.project.topic,
          goal: snapshot.project.goal.slice(0, 1_200),
          scope: snapshot.project.scope.slice(0, 1_200),
          status: snapshot.project.status
        })}`,
        `Questions: ${JSON.stringify(questionPromptRows(snapshot.questions))}`,
        `Hypotheses: ${JSON.stringify(hypothesisPromptRows(snapshot.hypotheses))}`,
        `ProjectContextSnapshot: ${JSON.stringify(projectContextPromptSummary(snapshot.projectContextSnapshots.at(-1)))}`,
        `ValidationResults: ${JSON.stringify(validationResultsForIteration(snapshot.validationResults, iteration))}`,
        `Hybrid Context: ${JSON.stringify(hybridContextPromptSummary(snapshot.hybridContexts.at(-1)))}`,
        `Selected Evidence: ${JSON.stringify(selectedEvidencePromptRows(snapshot))}`,
        `Selected Chunks: ${JSON.stringify(selectedChunkPromptRows(snapshot))}`,
        `Archived executor runs: ${JSON.stringify(legacyExecutionRunPromptRows(snapshot.legacyAgentRuns))}`,
        `Tool Runs: ${JSON.stringify(toolRunPromptRows(snapshot.toolRuns, 12))}`
      ].join("\n");
  return llm.completeJson<LlmResultResponse>({
    schemaName: "AetherOpsEvidenceBasedResult",
    system: "You are AetherOps, a Korean autonomous research agent. Return only valid JSON.",
    user,
    timeoutMs: 180_000
  });
}
