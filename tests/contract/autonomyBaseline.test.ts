import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreAutonomyFixture } from "../../scripts/autonomy/scorer.mjs";

const fixturePath = join(process.cwd(), "tests", "fixtures", "autonomy", "gpt-5.6-sol-high-baseline.json");

describe("gpt-5.6-sol/high autonomy live failure baseline", () => {
  it("is immutable, sanitized, and remains a failing 0/2 baseline", () => {
    const raw = readFileSync(fixturePath, "utf8");
    const fixture = JSON.parse(raw);
    const score = scoreAutonomyFixture(fixture);

    expect(createHash("sha256").update(raw).digest("hex")).toBe("cdf47c6e86993064c6863ca8f2fd7531ff30ae3d15fc6ee98aede59fc876ea72");
    expect(fixture.sourceReportSha256).toBe("315d14dad06ac2e3e103f6c3cde01f3ebe2194549de7d40f4fc6493045851703");
    expect(fixture.runtime).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "high", syntheticSuccess: false });
    expect(score).toMatchObject({ passed: false, passedCases: 0, totalCases: 2 });
    expect(score.hardViolationCount).toBeGreaterThanOrEqual(6);
  });
});
