import { isDeepStrictEqual } from "node:util";
import type { StorageV2RepositorySet } from "../v2/index.js";
import { parseStoredRunStateRevision } from "../v2/runStatePayloadValidator.js";
import type { StorageCommitRunStateRevisionInput } from "../v2/runStateTypes.js";
import type { StorageFencedWriteCommand } from "./typedProtocol.js";

export function executeFencedWrite(command: StorageFencedWriteCommand, repositories: StorageV2RepositorySet): unknown {
  switch (command.name) {
    case "taskContract.save":
      return repositories.runState.saveTaskContract(command.contract);
    case "event.append":
      return repositories.events.append(command.event);
    case "trace.llm.save":
      return repositories.trace.saveLlmInvocation(command.invocation);
    case "trace.decision.record":
      return repositories.trace.recordToolDecision(command.decision);
    case "trace.attempt.save": {
      const attempt = repositories.trace.saveToolAttempt(command.attempt);
      repositories.toolSideEffects.observeAttempt(attempt);
      return attempt;
    }
    case "trace.codex.save":
      return repositories.trace.saveCodexCliExecution(command.execution);
    case "trace.output.record":
      return repositories.trace.recordOutputLink(command.link);
    case "trace.network.record":
      return repositories.trace.recordNetworkAudit(command.audit);
    case "runState.commit": {
      const revision = parseStoredRunStateRevision(command.input.revision.data);
      if (revision.status === "completed" || revision.status === "failed" || revision.status === "cancelled") {
        throw new Error("Terminal canonical run-state revisions require canonical.transitionTerminal authority.");
      }
      assertGeneralCommitHasNoAuthorityProgress(repositories, command.input, revision);
      return repositories.runState.commitRevision(command.input);
    }
    case "contextPack.save":
      return repositories.runState.saveContextPack(command.input);
  }
}

function assertGeneralCommitHasNoAuthorityProgress(
  repositories: StorageV2RepositorySet,
  input: StorageCommitRunStateRevisionInput,
  revision: ReturnType<typeof parseStoredRunStateRevision>
): void {
  if (revision.status === "awaiting_completion") authorityError();
  const previous = repositories.runState.latestRevision(input.revision);
  if (!previous) {
    if (hasAuthorityRecords(revision)) authorityError();
    return;
  }
  const previousRevision = parseStoredRunStateRevision(previous.data);
  if (
    !isDeepStrictEqual(previousRevision.completedNodeReceipts, revision.completedNodeReceipts) ||
    !isDeepStrictEqual(previousRevision.artifactRefs, revision.artifactRefs) ||
    !isDeepStrictEqual(previousRevision.evidenceRefs, revision.evidenceRefs) ||
    !isDeepStrictEqual(previousRevision.verifiedFacts, revision.verifiedFacts)
  ) {
    authorityError();
  }
}

function hasAuthorityRecords(revision: ReturnType<typeof parseStoredRunStateRevision>): boolean {
  return Boolean(revision.completedNodeReceipts.length || revision.artifactRefs.length || revision.evidenceRefs.length || revision.verifiedFacts.length);
}

function authorityError(): never {
  throw new Error("Authority-bearing canonical progress requires a storage-worker verified canonical transition.");
}
