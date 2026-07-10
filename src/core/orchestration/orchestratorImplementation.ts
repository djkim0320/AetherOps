import { createId, nowIso } from "../shared/ids.js";
import { deriveResultWithLlm } from "../planning/llmPlanning.js";
import { LlmAccessUnavailableError } from "../providers/llm.js";
import { buildBenchmarkPlan, buildRunAuditOutput, RunAuditWriter } from "../output/runAuditWriter.js";
import {
  appendBulletSection,
  buildChatTranscript,
  buildLoopProgressReport,
  cleanStringArray,
  cleanText,
  selectDefaultChatSession,
  shouldReportIterationToChat,
  summarize
} from "./chatProgress.js";
import {
  ResearchLoopStep,
  type EvidenceBasedResult,
  type FlowKind,
  type LoopIteration,
  type ResearchArtifact,
  type ResearchProject,
  type ResearchSession,
  type ResearchSnapshot,
  type StepError
} from "../shared/types.js";
import { OrchestratorPreconditions } from "./orchestratorPreconditions.js";
import { RuntimeRequirementError } from "../tools/runtimeRequirements.js";
import { errorMetadata, formatError, hypothesisUpdateMap, mergeHypothesisUpdates } from "./orchestratorResultHelpers.js";

interface ChatReplyResponse {
  answer?: string;
  citations?: string[];
  limitations?: string[];
  nextActions?: string[];
}

export class AetherOpsOrchestrator extends OrchestratorPreconditions {
  protected async failProject(projectId: string, step: ResearchLoopStep, error: unknown): Promise<void> {
    if (error instanceof LlmAccessUnavailableError) {
      await this.blockProject(
        projectId,
        new RuntimeRequirementError(step, [
          {
            key: "llm.model_access",
            label: "Codex model account access",
            requiredForSteps: [step],
            isSatisfied: false,
            message: error.message
          }
        ])
      );
      return;
    }
    await this.moveProject(projectId, step, "failed");
    await this.saveStepError(projectId, step, formatError(error), "step_failed", errorMetadata(error, step));
    await this.record(projectId, step, "Error Flow", `연구 단계 실패: ${formatError(error)}`);
    await this.writeRunAudit(projectId, step, formatError(error));
  }

  protected async writeRunAudit(projectId: string, step: ResearchLoopStep, reason: string): Promise<void> {
    try {
      const snapshot = await this.store.getSnapshot(projectId);
      const output = snapshot.database
        ? await new RunAuditWriter(this.projectStorage).write(snapshot, snapshot.database, { step, reason })
        : buildRunAuditOutput(snapshot, { step, reason });
      await this.store.saveRunAuditOutput(output);
      await this.store.saveBenchmarkPlan(buildBenchmarkPlan(snapshot));
    } catch {
      // A failed audit must not mask the original failed research step.
    }
  }

  protected async saveStepError(projectId: string, step: ResearchLoopStep, message: string, cause: string, metadata: Record<string, unknown>): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const stepError: StepError = {
      id: createId("error"),
      projectId,
      step,
      message,
      cause,
      metadata,
      createdAt: nowIso()
    };
    await this.store.saveStepError(stepError);
    if (this.projectStorage.writeStepError) await this.projectStorage.writeStepError(snapshot.project, stepError);
  }

  protected async tryLlmResult(snapshot: ResearchSnapshot, iteration: number, forceStop: boolean): Promise<EvidenceBasedResult> {
    if (!this.llm || !(await this.llm.isAvailable())) {
      throw new Error("LLM provider is required to synthesize and evaluate results.");
    }
    const result = await deriveResultWithLlm(this.llm, snapshot, iteration, forceStop);
    if (!result?.answer) {
      throw new Error("LLM result synthesis did not return an answer.");
    }
    return result;
  }

  protected async applyHypothesisUpdates(projectId: string, result: EvidenceBasedResult): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const updates = hypothesisUpdateMap(result.hypothesisUpdates);
    await this.store.saveHypotheses(mergeHypothesisUpdates(snapshot.hypotheses, updates));
  }

  protected async setStatus(projectId: string, status: ResearchProject["status"]): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.store.updateProject({ ...snapshot.project, status, updatedAt: nowIso() });
    await this.syncProjectState(projectId);
  }

  protected async moveProject(projectId: string, currentStep: ResearchLoopStep, status?: ResearchProject["status"]): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    await this.store.updateProject({
      ...snapshot.project,
      currentStep,
      status: status ?? snapshot.project.status,
      updatedAt: nowIso()
    });
    await this.syncProjectState(projectId);
  }

  protected async record(projectId: string, step: ResearchLoopStep, flowKind: FlowKind, message: string): Promise<void> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration: LoopIteration = {
      id: createId("iteration"),
      projectId,
      iteration: Math.max(snapshot.openCodeRuns.length, snapshot.researchPlans.at(-1)?.iteration ?? 0),
      step,
      flowKind,
      message,
      createdAt: nowIso()
    };
    await this.store.saveIteration(iteration);
    await this.reportIterationToChat(iteration);
    await this.syncProjectState(projectId);
  }

  protected async reportIterationToChat(iteration: LoopIteration): Promise<void> {
    if (!shouldReportIterationToChat(iteration)) {
      return;
    }

    try {
      const snapshot = await this.store.getSnapshot(iteration.projectId);
      const session = selectDefaultChatSession(snapshot);
      if (!snapshot.database || !session) {
        return;
      }

      const content = buildLoopProgressReport(snapshot, iteration);
      const artifact: ResearchArtifact = {
        id: createId("artifact"),
        projectId: iteration.projectId,
        category: "conversation_memo",
        title: `${session.title} 루프 보고`,
        relativePath: `artifacts/chat/${session.id}-${Date.now()}-${iteration.id}-assistant.md`,
        mimeType: "text/markdown",
        summary: summarize(content),
        content,
        createdAt: iteration.createdAt
      };
      const [written] = await this.projectStorage.writeArtifacts(snapshot.project, snapshot.database, Math.max(iteration.iteration, 1), [artifact]);
      await this.store.saveArtifacts([written]);
    } catch (error) {
      console.warn(`Loop chat report failed: ${formatError(error)}`);
    }
  }

  protected async syncProjectState(projectId: string): Promise<void> {
    try {
      await this.projectStorage.writeProjectState(await this.store.getSnapshot(projectId));
    } catch (error) {
      console.warn(`Project state file sync failed: ${formatError(error)}`);
    }
  }

  protected async completeChatReply(snapshot: ResearchSnapshot, session: ResearchSession, message: string): Promise<string> {
    const latestContext = snapshot.hybridContexts.at(-1)?.contextText ?? snapshot.ragContexts.at(-1)?.contextText ?? snapshot.ragContexts.at(-1)?.summary;
    if (!this.llm) {
      throw new Error("LLM provider is not configured.");
    }
    const response = await this.llm.completeJson<ChatReplyResponse>({
      schemaName: "AetherOpsChatReply",
      system: [
        "You are the AetherOps research chat agent inside a project-based research workspace.",
        "Answer in Korean. Use stored evidence, artifacts, hybrid context, and limitations when relevant.",
        "Do not invent paper citations, URLs, DOI values, or experimental results.",
        'Return only JSON: {"answer": string, "citations": string[], "limitations": string[], "nextActions": string[]}.'
      ].join("\n"),
      user: [
        `Project topic: ${snapshot.project.topic}`,
        `Project goal: ${snapshot.project.goal}`,
        `Chat session: ${session.title} - ${session.focus}`,
        `Recent chat transcript:\n${buildChatTranscript(snapshot, session.id)}`,
        `Latest context:\n${latestContext ?? "No context yet."}`,
        `User message: ${message}`
      ].join("\n\n"),
      timeoutMs: 180_000
    });
    const answer = cleanText(response.answer);
    if (!answer) throw new Error("LLM 응답에 answer 필드가 없습니다.");
    const citations = cleanStringArray(response.citations);
    const limitations = cleanStringArray(response.limitations);
    const nextActions = cleanStringArray(response.nextActions);
    let output = answer;
    output = appendBulletSection(output, "근거/출처", citations);
    output = appendBulletSection(output, "한계", limitations);
    output = appendBulletSection(output, "다음 작업", nextActions);
    return output;
  }
}
