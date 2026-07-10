import { ResearchLoopStep, type LoopIteration, type ResearchArtifact, type ResearchSession, type ResearchSnapshot } from "../shared/types.js";

const ignoredChatProgressMessages = ["사용자 메시지", "LLM 응답", "세션이 생성", "세션을 삭제", "연구 프로젝트가 생성"];
const reportableChatSteps = new Set<ResearchLoopStep>([
  ResearchLoopStep.CreateResearchDb,
  ResearchLoopStep.InputResearchQuestionHypothesis,
  ResearchLoopStep.BuildResearchSpecification,
  ResearchLoopStep.PlanResearch,
  ResearchLoopStep.ExecuteTools,
  ResearchLoopStep.NormalizeData,
  ResearchLoopStep.BuildVectorIndex,
  ResearchLoopStep.BuildOntologyGraph,
  ResearchLoopStep.ReasonAndValidate,
  ResearchLoopStep.SynthesizeAndEvaluate,
  ResearchLoopStep.DecideContinuation,
  ResearchLoopStep.FinalizeOutputs
]);

export function countChatSessions(sessions: ResearchSession[]): number {
  let count = 0;
  for (const session of sessions) {
    if (!isLegacyStructuredSession(session.title)) count += 1;
  }
  return count;
}

export function isLegacyStructuredSession(title: string): boolean {
  return ["질문/가설 세션", "근거/RAG 세션", "실행/분석 세션"].includes(title);
}

export function buildChatTranscript(snapshot: ResearchSnapshot, sessionId: string): string {
  const messages = chatMessagesForSession(snapshot.artifacts, sessionId);
  if (!messages.length) return "No stored chat messages yet.";
  const lines: string[] = [];
  const start = Math.max(0, messages.length - 12);
  for (let index = start; index < messages.length; index += 1) {
    const artifact = messages[index];
    lines.push(`${artifact.relativePath.endsWith("-assistant.md") ? "assistant" : "user"}: ${artifact.content ?? artifact.summary}`);
  }
  return lines.join("\n\n");
}

export function chatMessagesForSession(artifacts: ResearchArtifact[], sessionId: string): ResearchArtifact[] {
  const messages: ResearchArtifact[] = [];
  const needle = `/chat/${sessionId}-`;
  for (const artifact of artifacts) {
    if (artifact.category !== "conversation_memo") continue;
    if (!artifact.relativePath.replace(/\\/g, "/").includes(needle)) continue;
    messages.push(artifact);
  }
  messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return messages;
}

export function selectDefaultChatSession(snapshot: ResearchSnapshot): ResearchSession | undefined {
  return snapshot.sessions.find((session) => !isLegacyStructuredSession(session.title)) ?? snapshot.sessions[0];
}

export function shouldReportIterationToChat(iteration: LoopIteration): boolean {
  if (isIgnoredChatProgressMessage(iteration.message)) {
    return false;
  }
  return reportableChatSteps.has(iteration.step);
}

export function isIgnoredChatProgressMessage(message: string): boolean {
  for (const ignored of ignoredChatProgressMessages) {
    if (message.includes(ignored)) return true;
  }
  return false;
}

export function countNonConversationArtifacts(artifacts: ResearchArtifact[]): number {
  let count = 0;
  for (const artifact of artifacts) {
    if (artifact.category !== "conversation_memo") count += 1;
  }
  return count;
}

export function buildLoopProgressReport(snapshot: ResearchSnapshot, iteration: LoopIteration): string {
  const label = stepReportLabel(iteration.step);
  const lines = [
    `### ${label}`,
    iteration.message,
    "",
    `- 반복: ${iteration.iteration || 0}`,
    `- 흐름: ${iteration.flowKind}`,
    `- 프로젝트 상태: ${snapshot.project.status}`,
    `- 누적 근거: ${snapshot.evidence.length}`,
    `- 누적 산출물: ${countNonConversationArtifacts(snapshot.artifacts)}`,
    `- 정규화 레코드: ${snapshot.normalizedRecords.length}`,
    `- Vector chunk: ${snapshot.chunks.length}`,
    `- Ontology graph: entity ${snapshot.ontologyEntities.length}, relation ${snapshot.ontologyRelations.length}`
  ];

  if (iteration.step === ResearchLoopStep.DecideContinuation) {
    const decision = snapshot.continuationDecisions.at(-1);
    if (decision) {
      lines.push("", `계속 연구 판단: ${decision.shouldContinue ? "계속" : "최종 산출로 이동"}`, `이유: ${decision.reason}`);
      if (decision.nextObjective) lines.push(`다음 목표: ${decision.nextObjective}`);
      if (decision.evidenceGaps.length) lines.push(`Evidence gap: ${decision.evidenceGaps.join(", ")}`);
    }
  }

  if (iteration.step === ResearchLoopStep.FinalizeOutputs) {
    const output = snapshot.finalOutputs.at(-1);
    const reportPath = output?.reportPath ?? snapshot.report?.reportPath;
    if (output?.finalAnswer) {
      lines.push("", "최종 답변", output.finalAnswer);
    }
    if (reportPath) {
      lines.push("", `보고서 파일: ${reportPath}`);
    }
  }

  return lines.join("\n");
}

export function stepReportLabel(step: ResearchLoopStep): string {
  const labels: Record<ResearchLoopStep, string> = {
    [ResearchLoopStep.CreateResearchDb]: "1. 연구 DB 생성",
    [ResearchLoopStep.InputResearchQuestionHypothesis]: "2. 연구 질문/가설 입력",
    [ResearchLoopStep.BuildResearchSpecification]: "3. 연구 명세 수립",
    [ResearchLoopStep.PlanResearch]: "4. 연구 계획 수립",
    [ResearchLoopStep.ExecuteTools]: "5. 도구 실행 및 연구 수행",
    [ResearchLoopStep.NormalizeData]: "6. 데이터 수집 및 정규화",
    [ResearchLoopStep.BuildVectorIndex]: "7. 임베딩 및 벡터 구조화",
    [ResearchLoopStep.BuildOntologyGraph]: "8. 온톨로지 기반 구조화",
    [ResearchLoopStep.ReasonAndValidate]: "9. 추론 및 검증",
    [ResearchLoopStep.SynthesizeAndEvaluate]: "10. 결과 합성 및 가설 평가",
    [ResearchLoopStep.DecideContinuation]: "11. 계속 연구 판단",
    [ResearchLoopStep.FinalizeOutputs]: "12. 최종 결과 도출"
  };
  return labels[step];
}

export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  for (const item of value) {
    const text = cleanText(item);
    if (!text) continue;
    output.push(text);
    if (output.length >= 8) break;
  }
  return output;
}

export function appendBulletSection(output: string, heading: string, items: string[]): string {
  if (!items.length) return output;
  let next = `${output}\n\n${heading}`;
  for (const item of items) {
    next += `\n- ${item}`;
  }
  return next;
}

export function summarize(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}
