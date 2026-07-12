const INFRASTRUCTURE_FAILURE_PATTERN =
  /(?:usage limit|purchase more credits|entitlement|model access|permission profile.*not enforceable|sandbox backend|gpt-5\.6-sol.*(?:not available|unavailable)|unsupported model)/i;

export function infrastructureFailureReason(run) {
  return [run.runtimeError?.message, run.jobDetail?.blockedReason, run.jobDetail?.failureReason].find(
    (message) => typeof message === "string" && INFRASTRUCTURE_FAILURE_PATTERN.test(message)
  );
}

export function infrastructureFailureMessages(runs) {
  return [...new Set(runs.map(({ run }) => infrastructureFailureReason(run)).filter(Boolean))];
}
