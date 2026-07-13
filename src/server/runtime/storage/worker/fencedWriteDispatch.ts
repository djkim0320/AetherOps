import type { StorageV2RepositorySet } from "../v2/index.js";
import type { StorageFencedWriteCommand } from "./typedProtocol.js";

export function executeFencedWrite(command: StorageFencedWriteCommand, repositories: StorageV2RepositorySet): unknown {
  switch (command.name) {
    case "event.append":
      return repositories.events.append(command.event);
    case "trace.llm.save":
      return repositories.trace.saveLlmInvocation(command.invocation);
    case "trace.decision.record":
      return repositories.trace.recordToolDecision(command.decision);
    case "trace.attempt.save":
      return repositories.trace.saveToolAttempt(command.attempt);
    case "trace.codex.save":
      return repositories.trace.saveCodexCliExecution(command.execution);
    case "trace.output.record":
      return repositories.trace.recordOutputLink(command.link);
    case "trace.network.record":
      return repositories.trace.recordNetworkAudit(command.audit);
  }
}
