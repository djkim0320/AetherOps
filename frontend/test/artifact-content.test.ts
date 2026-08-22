import assert from "node:assert/strict";
import test from "node:test";
import { artifactFormattedText, artifactRawText } from "../src/artifact-content.ts";

test("report presentation shows an honest inconclusive engineering outcome", () => {
    const content = {
      answer_markdown: "## 결론\n\n계산은 완료됐습니다.",
      engineering_assessment: {
        outcome: "inconclusive",
        outcome_reason: "asymptotic_grid_trend did not pass"
      }
    };
    const formatted = artifactFormattedText("research.report", content);
  assert.match(formatted, /공학 결론 미확정/);
  assert.match(formatted, /asymptotic_grid_trend did not pass/);
  assert.match(formatted, /## 결론/);
  assert.match(artifactRawText(content), /"engineering_assessment"/);
});

test("non-report artifact presentation remains unchanged", () => {
  assert.equal(artifactFormattedText("research.review", "plain review"), "plain review");
});
