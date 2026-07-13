import type { StorageJob, StorageV2RepositorySet } from "../v2/index.js";
import type { StorageFencedWriteCommand } from "./typedProtocol.js";

export function assertFencedWriteScope(
  command: StorageFencedWriteCommand,
  job: Pick<StorageJob, "id" | "projectId">,
  repositories: StorageV2RepositorySet
): void {
  if (command.name === "trace.output.record" && command.link.promoted) {
    throw new Error("Output promotion must be committed with the terminal completed transition.");
  }
  const value =
    command.name === "event.append"
      ? command.event
      : command.name === "trace.llm.save"
        ? command.invocation
        : command.name === "trace.decision.record"
          ? command.decision
          : command.name === "trace.attempt.save"
            ? command.attempt
            : command.name === "trace.codex.save"
              ? command.execution
              : command.name === "trace.output.record"
                ? command.link
                : command.audit;
  if (value.jobId !== job.id || value.projectId !== job.projectId) {
    throw new Error("Fenced storage write does not belong to the leased job.");
  }
  switch (command.name) {
    case "trace.llm.save":
      assertExistingScope(repositories.trace.getLlmInvocation(command.invocation.id), job, "LLM invocation identity");
      return;
    case "trace.decision.record":
      assertExistingLink(
        repositories.trace.getToolDecision(command.decision.id),
        job,
        "tool decision identity",
        command.decision.invocationId,
        (value) => value.invocationId
      );
      if (command.decision.invocationId) {
        assertParentScope(repositories.trace.getLlmInvocation(command.decision.invocationId), job, "LLM invocation");
      }
      return;
    case "trace.attempt.save":
      assertParentScope(repositories.trace.getToolDecision(command.attempt.decisionId), job, "tool decision");
      return;
    case "trace.codex.save":
      assertExistingLink(
        repositories.trace.getCodexCliExecution(command.execution.id),
        job,
        "Codex execution identity",
        command.execution.attemptId,
        (value) => value.attemptId
      );
      assertParentScope(repositories.trace.getToolAttempt(command.execution.attemptId), job, "tool attempt");
      return;
    case "trace.output.record":
      assertParentScope(repositories.trace.getToolAttempt(command.link.attemptId), job, "tool attempt");
      return;
    case "trace.network.record":
      if (command.audit.attemptId) assertParentScope(repositories.trace.getToolAttempt(command.audit.attemptId), job, "tool attempt");
      return;
    default:
      return;
  }
}

function assertExistingScope(parent: { jobId: string; projectId: string } | undefined, job: Pick<StorageJob, "id" | "projectId">, label: string): void {
  if (parent) assertParentScope(parent, job, label);
}

function assertExistingLink<T extends { jobId: string; projectId: string }>(
  existing: T | undefined,
  job: Pick<StorageJob, "id" | "projectId">,
  label: string,
  expectedLink: string | undefined,
  link: (value: T) => string | undefined
): void {
  if (!existing) return;
  assertParentScope(existing, job, label);
  if (link(existing) !== expectedLink) throw new Error(`Fenced trace ${label} linkage is immutable.`);
}

function assertParentScope(parent: { jobId: string; projectId: string } | undefined, job: Pick<StorageJob, "id" | "projectId">, label: string): void {
  if (!parent || parent.jobId !== job.id || parent.projectId !== job.projectId) {
    throw new Error(`Fenced trace ${label} linkage does not belong to the leased job.`);
  }
}
