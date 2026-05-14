import { createId, nowIso } from "./ids.js";
import type { RagContext, RagEngine, ResearchSnapshot } from "./types.js";

export class SimpleRagEngine implements RagEngine {
  async buildContext(snapshot: ResearchSnapshot): Promise<RagContext> {
    const query = [
      snapshot.project.topic,
      ...snapshot.questions.map((item) => item.text),
      ...snapshot.hypotheses.map((item) => item.statement)
    ].join(" ");

    const selectedEvidence = snapshot.evidence
      .map((item) => ({
        item,
        score: this.score(`${item.title} ${item.summary} ${item.keywords.join(" ")}`, query)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ item }) => item);

    const selectedArtifacts = snapshot.artifacts.slice(-4);

    return {
      id: createId("rag"),
      projectId: snapshot.project.id,
      query,
      evidenceIds: selectedEvidence.map((item) => item.id),
      artifactIds: selectedArtifacts.map((item) => item.id),
      summary: this.summarize(selectedEvidence.map((item) => item.summary)),
      createdAt: nowIso()
    };
  }

  private score(text: string, query: string): number {
    const queryTokens = new Set(this.tokenize(query));
    return this.tokenize(text).reduce((score, token) => score + (queryTokens.has(token) ? 1 : 0), 0);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  private summarize(summaries: string[]): string {
    if (!summaries.length) {
      return "아직 검색 가능한 근거가 충분하지 않습니다. 다음 OpenCode 실행에서 자료 수집을 우선합니다.";
    }
    return summaries.slice(0, 3).join(" ");
  }
}
