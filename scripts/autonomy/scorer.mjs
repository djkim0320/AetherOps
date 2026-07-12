export function scoreAutonomyFixture(fixture) {
  if (!fixture || fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases)) {
    throw new Error("Unsupported autonomy fixture schema.");
  }
  const cases = fixture.cases.map(scoreCase);
  const selectedRequired = cases.reduce((sum, item) => sum + item.selectedRequired, 0);
  const requiredCount = cases.reduce((sum, item) => sum + item.requiredCount, 0);
  const selectedAllowed = cases.reduce((sum, item) => sum + item.selectedAllowed, 0);
  const selectedCount = cases.reduce((sum, item) => sum + item.selectedCount, 0);
  return {
    fixtureKind: fixture.fixtureKind,
    model: fixture.runtime?.model,
    reasoningEffort: fixture.runtime?.reasoningEffort,
    passed: cases.every((item) => item.passed),
    passedCases: cases.filter((item) => item.passed).length,
    totalCases: cases.length,
    toolRecall: ratio(selectedRequired, requiredCount),
    toolPrecision: ratio(selectedAllowed, selectedCount),
    hardViolationCount: cases.reduce((sum, item) => sum + item.hardViolations.length, 0),
    cases
  };
}

function scoreCase(testCase) {
  const selected = unique(testCase.observed?.resolvedTools);
  const required = unique(testCase.expected?.requiredTools);
  const forbidden = unique(testCase.expected?.forbiddenTools);
  const selectedRequired = required.filter((tool) => selected.includes(tool)).length;
  const forbiddenSelected = forbidden.filter((tool) => selected.includes(tool));
  const selectedAllowed = selected.filter((tool) => !forbidden.includes(tool)).length;
  const hardViolations = [];
  if (forbiddenSelected.length) hardViolations.push("FORBIDDEN_TOOL_SELECTED");
  if ((testCase.observed?.toolLifecycleSseCount ?? 0) === 0) hardViolations.push("TOOL_TRACE_MISSING");
  if (Array.isArray(testCase.expected?.allowedUrls)) {
    const allowed = new Set(testCase.expected.allowedUrls);
    if ((testCase.observed?.evidenceUrls ?? []).some((url) => !allowed.has(url))) hardViolations.push("SOURCE_SCOPE_VIOLATION");
  }
  if (testCase.expected?.requiredEngineeringTarget && testCase.observed?.engineeringTarget !== testCase.expected.requiredEngineeringTarget) {
    hardViolations.push("WRONG_SOLVER");
  }
  if ((testCase.observed?.committedEvidenceCount ?? 0) > 0 && testCase.observed?.terminalStep === "EXECUTE_TOOLS") {
    hardViolations.push("QUARANTINE_LEAK");
  }
  if (testCase.observed?.geometryBinding === "configuredCase-without-identifier") hardViolations.push("UNGROUNDED_ARGUMENT");
  return {
    id: testCase.id,
    passed: selectedRequired === required.length && hardViolations.length === 0,
    requiredCount: required.length,
    selectedRequired,
    selectedCount: selected.length,
    selectedAllowed,
    forbiddenSelected,
    hardViolations: unique(hardViolations)
  };
}

function unique(values) {
  return [...new Set(Array.isArray(values) ? values.filter((value) => typeof value === "string" && value) : [])];
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : 1;
}
