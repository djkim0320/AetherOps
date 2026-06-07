import { createId, nowIso } from "./ids.js";
import type { RagContext, RagEngine, ResearchSnapshot } from "./types.js";

export class SimpleRagEngine implements RagEngine {
  async buildContext(snapshot: ResearchSnapshot): Promise<RagContext> {
    const queryParts = [snapshot.project.topic];
    for (const question of snapshot.questions) queryParts.push(question.text);
    for (const hypothesis of snapshot.hypotheses) queryParts.push(hypothesis.statement);
    const query = queryParts.join(" ");
    const queryTokens = new Set(this.tokenize(query));

    const scoredEvidence: Array<{ item: ResearchSnapshot["evidence"][number]; score: number }> = [];
    for (const item of snapshot.evidence) {
      scoredEvidence.push({
        item,
        score: this.score(`${item.title} ${item.summary} ${item.keywords.join(" ")}`, queryTokens)
      });
    }
    scoredEvidence.sort((a, b) => b.score - a.score);

    const evidenceIds: string[] = [];
    const citations: string[] = [];
    const retrievalScores: Record<string, number> = {};
    const contextParts: string[] = [];
    const summaries: string[] = [];
    const evidenceLimit = Math.min(scoredEvidence.length, 6);
    for (let index = 0; index < evidenceLimit; index += 1) {
      const item = scoredEvidence[index]?.item;
      if (!item) continue;
      evidenceIds.push(item.id);
      summaries.push(item.summary);
      citations.push(item.citation || item.sourceUri || item.title);
      retrievalScores[item.id] = Number((1 / (index + 1)).toFixed(4));
      contextParts.push(`${item.title}\n${item.summary}`);
    }

    return {
      id: createId("rag"),
      projectId: snapshot.project.id,
      query,
      evidenceIds,
      artifactIds: recentArtifactIds(snapshot, 4),
      summary: this.summarize(summaries),
      chunkIds: [],
      citations,
      retrievalScores,
      contextText: contextParts.join("\n\n"),
      createdAt: nowIso()
    };
  }

  private score(text: string, queryTokens: Set<string>): number {
    let score = 0;
    for (const token of this.tokenize(text)) {
      if (queryTokens.has(token)) score += 1;
    }
    return score;
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").match(/\S+/g) ?? [];
  }

  private summarize(summaries: string[]): string {
    if (!summaries.length) {
      return "검색 가능한 근거가 아직 충분하지 않습니다. 다음 실행에서 자료 수집을 우선합니다.";
    }
    const selected: string[] = [];
    const limit = Math.min(summaries.length, 3);
    for (let index = 0; index < limit; index += 1) {
      const summary = summaries[index];
      if (summary) selected.push(summary);
    }
    return selected.join(" ");
  }
}

function recentArtifactIds(snapshot: ResearchSnapshot, limit: number): string[] {
  const artifactIds: string[] = [];
  const start = Math.max(0, snapshot.artifacts.length - limit);
  for (let index = start; index < snapshot.artifacts.length; index += 1) {
    const artifact = snapshot.artifacts[index];
    if (artifact) artifactIds.push(artifact.id);
  }
  return artifactIds;
}
