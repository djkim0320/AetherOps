import type { ResearchToolResult } from "./researchToolTypes.js";
import type { ScheduledToolAction } from "./toolDependencyScheduler.js";

export interface ActionFailure {
  action: ScheduledToolAction;
  failure: Error;
  failedResult?: ResearchToolResult;
  message?: string;
}

export class ActionGroupFailure extends Error {
  constructor(readonly failures: ActionFailure[]) {
    super(failures.map((item) => `${item.action.toolName}: ${item.failure.message}`).join("; "));
    this.name = "ActionGroupFailure";
  }
}

export function actionError(action: ScheduledToolAction, failure: Error, failedResult?: ResearchToolResult, message?: string): ActionFailure {
  return { action, failure, failedResult, message };
}

export function asActionFailure(error: unknown, fallback: ScheduledToolAction | undefined): ActionFailure {
  if (isActionFailure(error)) return error;
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!fallback) throw failure;
  return { action: fallback, failure };
}

export function actionFailures(error: unknown, fallback: ScheduledToolAction | undefined): ActionFailure[] {
  if (error instanceof ActionGroupFailure) return error.failures;
  return [asActionFailure(error, fallback)];
}

function isActionFailure(value: unknown): value is ActionFailure {
  return Boolean(value && typeof value === "object" && "action" in value && "failure" in value);
}
