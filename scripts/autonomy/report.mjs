export function renderAutonomyReport(result) {
  const lines = [
    "# AetherOps autonomy verification",
    "",
    `- Profile: \`${result.profile}\``,
    `- Verdict: **${result.verdict}**`,
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    `- Infrastructure failures: ${result.infrastructureFailures.length}`,
    ""
  ];
  if (result.runtime) {
    lines.push(
      "## Runtime",
      "",
      `- Model: \`${result.runtime.model}\``,
      `- Reasoning: \`${result.runtime.reasoningEffort}\``,
      `- Timeout: ${result.runtime.timeoutMs} ms`,
      ""
    );
  }
  if (result.offline) {
    lines.push(
      "## Offline verification",
      "",
      `- Real checks passed: ${result.offline.checks.filter((item) => item.passed).length}/${result.offline.checks.length}`,
      `- Immutable failure baseline: ${result.offline.baseline.passedCases}/${result.offline.baseline.totalCases} (scorer validation only)`,
      ""
    );
  }
  if (result.cases.length) {
    lines.push(
      "## Golden cases",
      "",
      "| Case | Run | Expected | Observed | Verdict | Recall | Precision | Gates | Violations |",
      "|---|---:|---|---|---|---:|---:|---|---:|"
    );
    for (const item of result.cases) {
      lines.push(
        `| ${item.caseId} | ${item.repetition} | ${item.expectedOutcome} | ${item.observedOutcome} | ${item.observedOutcome === "infrastructure_failure" ? "INFRA" : item.passed ? "PASS" : "FAIL"} | ${percent(item.toolRecall)} | ${percent(item.toolPrecision)} | ${gateText(item.gates)} | ${item.hardViolations.length} |`
      );
    }
    lines.push("");
    const plannerLatencies = result.cases.flatMap((item) => item.plannerLatencyMs ?? []).sort((a, b) => a - b);
    lines.push(
      "## Reliability metrics",
      "",
      `- First-pass planner schema rate: ${percent(average(result.cases.map((item) => item.firstPassSchemaRate)))}`,
      `- Planner repair rate: ${percent(average(result.cases.map((item) => item.plannerRepairRate)))}`,
      `- Planner latency p50/p95: ${percentile(plannerLatencies, 0.5)} ms / ${percentile(plannerLatencies, 0.95)} ms`,
      `- SSE lifecycle failures: ${result.cases.filter((item) => item.gates?.sse === false).length}`,
      `- Clark-Y polar hashes: ${[...new Set(result.cases.map((item) => item.canonicalPolarHash).filter(Boolean))].join(", ") || "not observed"}`,
      ""
    );
  }
  if (result.infrastructureFailures.length) {
    lines.push("## Infrastructure failures", "", ...result.infrastructureFailures.map((message) => `- ${message}`), "");
  }
  lines.push("The immutable baseline is never counted as live success. No skipped live case is converted to a pass.", "");
  return lines.join("\n");
}

function percent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return `${Math.round((value ?? 0) * 100)}%`;
}

function gateText(gates = {}) {
  return Object.entries(gates)
    .map(([name, passed]) => `${name}:${passed ? "✓" : "✗"}`)
    .join(" ");
}

function average(values) {
  const measured = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : undefined;
}

function percentile(values, fraction) {
  if (!values.length) return "N/A";
  return Math.round(values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]);
}
