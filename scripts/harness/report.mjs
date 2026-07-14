export function renderHarnessReport(result) {
  const lines = [
    "# AetherBench M0 report",
    "",
    `- Command: \`${result.command}\``,
    `- Harness verdict: **${result.harnessVerdict}**`,
    `- Harness mechanics verdict: **${result.harnessMechanicsVerdict}**`,
    `- M0 release readiness: **${result.m0ReleaseReadiness}**`,
    `- Release blockers: ${(result.releaseBlockers ?? []).join(", ") || "none"}`,
    `- Product verdict: **${result.productVerdict}**`,
    `- Production-success eligible: \`${result.productionSuccessEligible}\``,
    `- Evidence class: \`${result.evidenceClass}\``,
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    "",
    "> A deterministic test-runtime pass verifies the harness only. Live-provider and production-runtime behavior were not evaluated.",
    "",
    "## Historical reference",
    "",
    `- Anchor commit: \`${result.baseline.anchorCommit}\``,
    `- Baseline verdict: **${result.baseline.baselineVerdict}**`,
    `- Measurement complete: \`${result.baseline.measurementCompleteness}\``,
    `- Missing metrics: ${(result.baseline.missingMetrics ?? []).join(", ") || "none"}`,
    `- Historical fixture: \`${result.baseline.historicalFixture.path}\``,
    `- Historical scorer result: ${result.baseline.historicalFixture.score.passedCases}/${result.baseline.historicalFixture.score.totalCases}`,
    `- Historical source commit: ${result.baseline.historicalFixture.sourceCommit ?? `not measured (${result.baseline.historicalFixture.sourceCommitReason})`}`,
    ""
  ];
  if (result.runs.length) renderRuns(lines, result.runs);
  renderUnmeasured(lines, result.unmeasuredMetrics);
  if (result.failures.length) lines.push("## Failures", "", ...result.failures.map((failure) => `- ${failure.code}: ${failure.message}`), "");
  lines.push("Historical scorer reproduction, harness verification, and product success are separate verdicts.", "");
  return lines.join("\n");
}

function renderRuns(lines, runs) {
  lines.push("## Deterministic evaluation", "", "| Partition | Suite | Case | Result | Acceptance |", "|---|---|---|---|---:|");
  for (const run of runs) {
    const accepted = run.acceptanceResults?.filter((entry) => entry.passed).length ?? 0;
    const total = run.acceptanceResults?.length ?? 0;
    lines.push(`| ${run.classification ?? "unknown"} | ${run.suite} | ${run.caseId} | ${run.result} | ${accepted}/${total} |`);
  }
  lines.push("");
}

function renderUnmeasured(lines, metrics) {
  lines.push("## Unmeasured production metrics", "", "| Metric | Value | Reason |", "|---|---|---|");
  for (const [name, metric] of Object.entries(metrics)) {
    lines.push(`| ${name} | ${metric.value ?? "null"} ${metric.unit} | ${metric.unmeasuredReason} |`);
  }
  lines.push("");
}
