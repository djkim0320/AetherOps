import { describe, expect, it } from "vitest";
import type { ResearchToolInput } from "../../../core/shared/types.js";
import { buildMetadataQueries } from "./metadataQueries.js";

describe("buildMetadataQueries", () => {
  it("prioritizes the validated planner query over broader project text", () => {
    const input = {
      project: { topic: "한국어로 작성된 광범위한 프로젝트 설명", goal: "학술 문헌을 수집한다" },
      questions: [],
      hypotheses: []
    } as unknown as ResearchToolInput;

    expect(buildMetadataQueries(input, "Clark Y airfoil wind tunnel validation")[0]).toBe("Clark Y airfoil wind tunnel validation");
  });
});
