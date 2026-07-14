import type { StorageFencedWriteCommand } from "../worker/typedProtocol.js";
import type { StorageToolAttempt } from "./traceTypes.js";
import type { StorageJob } from "./types.js";

export function fencedAttemptCommands(job: StorageJob, attempt: StorageToolAttempt): StorageFencedWriteCommand[] {
  const decision: StorageFencedWriteCommand = {
    name: "trace.decision.record",
    decision: {
      id: attempt.decisionId,
      projectId: job.projectId,
      jobId: job.id,
      toolName: "TestTool",
      purpose: "Exercise durable attempt state.",
      expectedOutcome: "A persisted attempt.",
      rawSelection: {},
      userPinned: false,
      policyStatus: "accepted",
      createdAt: attempt.queuedAt
    }
  };
  const terminalPrerequisite: StorageFencedWriteCommand[] =
    attempt.status === "completed"
      ? [
          {
            name: "trace.attempt.save",
            attempt: { ...attempt, status: "running", outputHash: undefined, terminalCause: undefined, completedAt: undefined }
          }
        ]
      : [];
  return [decision, ...terminalPrerequisite, { name: "trace.attempt.save", attempt }];
}
