import { describe, expect, it } from "vitest";
import { assessSourceQuality, rankResearchUrls } from "./sourceQuality.js";

describe("source quality policy", () => {
  it("prioritizes scholarly and public sources before weak web pages", () => {
    const ranked = rankResearchUrls([
      "https://namu.wiki/w/vector%20database",
      "https://example.com/blog/vector-database",
      "https://arxiv.org/abs/2005.11401",
      "https://www.nist.gov/itl/ai-risk-management-framework"
    ]);

    expect(ranked[0]).toContain("arxiv.org");
    expect(ranked[1]).toContain("nist.gov");
    expect(ranked.at(-1)).toContain("namu.wiki");
  });

  it("treats search/discovery pages as non-citable sources", () => {
    expect(assessSourceQuality("https://scholar.google.com/scholar?q=rag").canSupportHypothesis).toBe(false);
    expect(assessSourceQuality("https://search.crossref.org/?q=rag").canSupportHypothesis).toBe(false);
    expect(assessSourceQuality("https://www.semanticscholar.org/search?q=rag").canSupportHypothesis).toBe(false);
    expect(assessSourceQuality("https://www.semanticscholar.org/paper/abc123").canSupportHypothesis).toBe(true);
  });
});
