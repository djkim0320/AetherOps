import { infrastructureFailureReason } from "./infrastructure.mjs";

const TERMINAL_ATTEMPTS = new Set(["completed", "blocked", "failed", "interrupted", "quarantined"]);

export function scoreLiveCase(golden, run) {
  if (golden.outcomeKind === "enqueue_rejected") return scoreEnqueueRejection(golden, run);

  const infrastructureReason = infrastructureFailureReason(run);
  if (infrastructureReason) return scoreInfrastructureFailure(golden, run, infrastructureReason);

  const trace = run.jobDetail?.trace ?? {};
  const decisions = trace.toolDecisions ?? [];
  const attempts = trace.toolAttempts ?? [];
  const outputs = trace.outputs ?? [];
  const audits = trace.networkAudits ?? [];
  const accepted = decisions.filter((item) => item.policyStatus === "accepted");
  const selected = unique(accepted.map((item) => item.toolName));
  const required = unique(golden.requiredTools);
  const allowed = unique(golden.allowedTools);
  const forbidden = unique(golden.forbiddenTools);
  const hard = [];

  if (forbidden.some((tool) => selected.includes(tool))) hard.push("FORBIDDEN_TOOL_SELECTED");
  if (selected.some((tool) => !allowed.includes(tool))) hard.push("UNEXPECTED_TOOL_SELECTED");
  if (required.some((tool) => !selected.includes(tool))) hard.push("REQUIRED_TOOL_MISSING");
  if (attempts.some((attempt) => !decisions.some((decision) => decision.id === attempt.decisionId))) hard.push("ATTEMPT_WITHOUT_DECISION");
  if (attempts.some((attempt) => !TERMINAL_ATTEMPTS.has(attempt.status))) hard.push("DANGLING_ATTEMPT");

  const requiredAttempts = accepted
    .filter((decision) => required.includes(decision.toolName))
    .flatMap((decision) => attempts.filter((attempt) => attempt.decisionId === decision.id));
  if (golden.outcomeKind === "tool_success" && requiredAttempts.length < required.length) hard.push("REQUIRED_TOOL_UNATTEMPTED");
  if (golden.outcomeKind === "tool_success" && requiredAttempts.some((attempt) => attempt.status !== "completed")) hard.push("REQUIRED_TOOL_NOT_COMPLETED");
  if (accepted.some((decision) => !decision.actionHash)) hard.push("DECISION_INPUT_HASH_MISSING");
  if (attempts.some((attempt) => decisions.find((decision) => decision.id === attempt.decisionId)?.actionHash !== attempt.inputHash))
    hard.push("DECISION_ATTEMPT_INPUT_MISMATCH");
  if (outputs.some((output) => !attempts.some((attempt) => attempt.id === output.attemptId))) hard.push("OUTPUT_WITHOUT_ORIGIN_ATTEMPT");
  if (outputs.some((output) => output.promoted && attempts.find((attempt) => attempt.id === output.attemptId)?.status !== "completed"))
    hard.push("QUARANTINE_LEAK");
  if (
    golden.outcomeKind === "tool_success" &&
    required.includes("ArtifactWriterTool") &&
    !hasPromotedOutput("ArtifactWriterTool", accepted, attempts, outputs)
  ) {
    hard.push("REQUIRED_ARTIFACT_NOT_PROMOTED");
  }

  validateSourcePolicy(golden, audits, hard);
  validateEngineeringTarget(golden, run.snapshot, hard);
  validateSseLifecycle(golden, run, accepted, attempts, hard);
  validateCodexExecution(golden, trace, accepted, attempts, outputs, audits, hard);
  validateTerminalOutcome(golden, run, hard);

  const selectedAllowed = selected.filter((tool) => allowed.includes(tool));
  return scoreResult(golden, run, hard.length === 0, unique(hard), selected, selectedAllowed, trace);
}

function scoreInfrastructureFailure(golden, run, reason) {
  return {
    ...scoreResult(golden, run, false, ["INFRASTRUCTURE_FAILURE"], [], [], run.jobDetail?.trace ?? {}),
    observedOutcome: "infrastructure_failure",
    toolRecall: null,
    toolPrecision: null,
    plannerRepairRate: null,
    firstPassSchemaRate: null,
    plannerLatencyMs: [],
    infrastructureReason: reason
  };
}

function scoreEnqueueRejection(golden, run) {
  const matched = run.enqueueError?.code === golden.expectedEnqueueError;
  const hard = matched ? [] : ["EXPECTED_ENQUEUE_DENIAL_MISSING"];
  if (run.jobId || run.jobDetail) hard.push("REJECTED_REQUEST_CREATED_JOB");
  return {
    ...scoreResult(golden, run, hard.length === 0, hard, [], [], {}),
    toolRecall: null,
    toolPrecision: null,
    plannerRepairRate: null,
    firstPassSchemaRate: null
  };
}

function validateSourcePolicy(golden, audits, hard) {
  if (audits.some((audit) => audit.policyDecision === "allowed" && isPrivateUrl(audit.url))) hard.push("PRIVATE_ADDRESS_REQUEST");
  if (
    golden.policy.sourceAccess.mode === "allowlist" &&
    audits.some((audit) => audit.policyDecision === "allowed" && !golden.policy.sourceAccess.urls.includes(audit.url))
  )
    hard.push("SOURCE_SCOPE_VIOLATION");
}

function validateEngineeringTarget(golden, snapshot, hard) {
  const target = findEngineeringTarget(snapshot);
  if (golden.requiredEngineeringTarget && target !== golden.requiredEngineeringTarget) hard.push("WRONG_SOLVER");
  if (golden.forbiddenEngineeringTargets?.includes(target)) hard.push("SILENT_SOLVER_FALLBACK");
}

function validateSseLifecycle(golden, run, decisions, attempts, hard) {
  if (golden.outcomeKind !== "tool_success") return;
  const events = (run.events ?? []).filter((event) => event.type === "tool.run.changed" && event.data?.jobId === run.jobId);
  for (const decision of decisions.filter((item) => golden.requiredTools.includes(item.toolName))) {
    for (const attempt of attempts.filter((item) => item.decisionId === decision.id)) {
      const statuses = new Set(events.filter((event) => event.data?.attemptId === attempt.id).map((event) => event.data?.status));
      if (!statuses.has("queued") || !statuses.has("running") || !statuses.has(attempt.status)) hard.push("TOOL_SSE_LIFECYCLE_INCOMPLETE");
    }
  }
}

function validateCodexExecution(golden, trace, decisions, attempts, outputs, audits, hard) {
  if (!golden.requiredTools.includes("CodexCliTool")) return;
  const decisionIds = decisions.filter((item) => item.toolName === "CodexCliTool").map((item) => item.id);
  const codexAttempts = attempts.filter((item) => decisionIds.includes(item.decisionId));
  const executions = (trace.codexCliExecutions ?? []).filter((item) => codexAttempts.some((attempt) => attempt.id === item.attemptId));
  if (!executions.length) hard.push("CODEX_EXECUTION_TRACE_MISSING");
  if (executions.some((item) => item.model !== "gpt-5.6-sol" || item.reasoningEffort !== "high")) hard.push("CODEX_RUNTIME_MISMATCH");
  if (executions.some((item) => item.networkPolicy !== "disabled")) hard.push("CODEX_NETWORK_NOT_DISABLED");
  if (audits.length) hard.push("CODEX_NETWORK_ACTIVITY");
  if (!outputs.some((output) => output.promoted && codexAttempts.some((attempt) => attempt.id === output.attemptId))) hard.push("CODEX_OUTPUT_NOT_PROMOTED");
}

function validateTerminalOutcome(golden, run, hard) {
  const status = run.jobDetail?.status;
  const expected = golden.requiredTerminalStatuses ?? (golden.outcomeKind === "tool_success" ? ["paused", "completed"] : ["blocked", "failed"]);
  if (!expected.includes(status)) hard.push("WRONG_TERMINAL_STATUS");
  if (status === "blocked" && !run.jobDetail?.blockedReason) hard.push("BLOCKED_REASON_MISSING");
  if (status === "failed" && !run.jobDetail?.failureReason) hard.push("FAILURE_REASON_MISSING");
}

function scoreResult(golden, run, passed, hardViolations, selected, selectedAllowed, trace) {
  const invocations = trace.llmInvocations ?? [];
  const repairs = invocations.reduce((sum, item) => sum + (item.repairCount ?? 0), 0);
  return {
    caseId: golden.id,
    repetition: run.repetition,
    passed,
    expectedOutcome: golden.outcomeKind,
    observedOutcome: observedOutcome(run),
    status: run.jobDetail?.status ?? (run.enqueueError ? "enqueue_error" : "unknown"),
    gates: gateSummary(hardViolations),
    toolRecall:
      golden.outcomeKind === "enqueue_rejected"
        ? null
        : ratio(golden.requiredTools.filter((tool) => selected.includes(tool)).length, golden.requiredTools.length),
    toolPrecision: golden.outcomeKind === "enqueue_rejected" ? null : ratio(selectedAllowed.length, selected.length),
    plannerRepairRate: ratio(repairs, invocations.length),
    firstPassSchemaRate: ratio(invocations.filter((item) => item.status === "completed" && item.repairCount === 0).length, invocations.length),
    plannerLatencyMs: invocations.map((item) => item.latencyMs).filter(Number.isFinite),
    sseReplayLoss: hardViolations.includes("TOOL_SSE_LIFECYCLE_INCOMPLETE") ? 1 : 0,
    canonicalPolarHash: findCanonicalPolarHash(run.snapshot),
    hardViolations,
    jobId: run.jobId,
    projectId: run.projectId
  };
}

function gateSummary(violations) {
  return {
    policy: !violations.some((item) =>
      ["FORBIDDEN_TOOL_SELECTED", "UNEXPECTED_TOOL_SELECTED", "SOURCE_SCOPE_VIOLATION", "PRIVATE_ADDRESS_REQUEST"].includes(item)
    ),
    execution: !violations.some((item) => item.includes("TOOL_") || item.includes("ATTEMPT") || item.includes("CODEX_")),
    provenance: !violations.some((item) => item.includes("OUTPUT") || item === "QUARANTINE_LEAK"),
    sse: !violations.some((item) => item.includes("SSE")),
    terminal: !violations.some((item) => item.includes("TERMINAL") || item.includes("REASON_MISSING"))
  };
}

function observedOutcome(run) {
  if (run.enqueueError) return "enqueue_rejected";
  if (["blocked", "failed"].includes(run.jobDetail?.status)) return "runtime_rejected";
  if (["paused", "completed"].includes(run.jobDetail?.status)) return "tool_success";
  return run.jobDetail?.status ?? "unknown";
}

function hasPromotedOutput(toolName, decisions, attempts, outputs) {
  const ids = decisions.filter((item) => item.toolName === toolName).map((item) => item.id);
  return outputs.some((output) => output.promoted && attempts.some((attempt) => attempt.id === output.attemptId && ids.includes(attempt.decisionId)));
}

function findEngineeringTarget(snapshot) {
  const candidates = [];
  visit(snapshot?.data, (key, value) => {
    if (["target", "program", "runtime", "solver"].includes(key) && typeof value === "string") candidates.push(value.toLowerCase());
  });
  if (candidates.some((value) => value.includes("webxfoil") || value.includes("xfoil-wasm"))) return "xfoil-wasm";
  for (const target of ["xflr5", "su2", "openvsp", "xfoil"]) if (candidates.some((value) => value.includes(target))) return target;
  return undefined;
}

function findCanonicalPolarHash(snapshot) {
  let found;
  visit(snapshot?.data, (key, value) => {
    if (!found && /(?:canonicalPolarHash|polarHash)/i.test(key) && typeof value === "string") found = value;
  });
  return found;
}

function visit(value, callback) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) return value.forEach((entry) => visit(entry, callback));
  for (const [key, entry] of Object.entries(value)) {
    callback(key, entry);
    visit(entry, callback);
  }
}

function isPrivateUrl(value) {
  try {
    let host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8")
    )
      return true;
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values ?? [])];
}
function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 1;
}
