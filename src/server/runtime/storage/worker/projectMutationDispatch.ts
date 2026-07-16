import { finalizeProjectMutation, markProjectMutationLegacyApplied, prepareProjectMutation, type StorageV2RepositorySet } from "../v2/index.js";
import type { StorageProjectMutationCommand, StorageWorkerCommand } from "./typedProtocol.js";

export function isProjectMutationCommand(command: StorageWorkerCommand): command is StorageProjectMutationCommand {
  return command.name.startsWith("projectMutation.");
}

export function dispatchProjectMutationCommand(command: StorageProjectMutationCommand, repositories: StorageV2RepositorySet): unknown {
  switch (command.name) {
    case "projectMutation.prepare":
      return prepareProjectMutation(repositories, command.input);
    case "projectMutation.lookup":
      return repositories.projectMutations.lookup({ method: command.method, requestId: command.requestId }, command.requestHash);
    case "projectMutation.markLegacyApplied":
      return markProjectMutationLegacyApplied(repositories, command.input);
    case "projectMutation.finalize":
      return finalizeProjectMutation(repositories, command.input);
    case "projectMutation.listPending":
      return repositories.projectMutations.listPending(command.cursor, command.limit);
  }
}
