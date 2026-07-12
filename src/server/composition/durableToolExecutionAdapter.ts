import { createHash } from "node:crypto";
import type { ToolExecutionStatusEvent } from "../../core/tools/researchToolTypes.js";
import type { StorageToolAttempt, StorageToolOutputLink } from "../runtime/storage/v2/traceTypes.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { redactTraceText, sanitizeTraceRecord } from "../runtime/security/traceSanitizer.js";

interface AttemptState {
  attempt: StorageToolAttempt;
  toolName: string;
  outputs: NonNullable<ToolExecutionStatusEvent["outputs"]>;
}

export class DurableToolExecutionAdapter {
  private readonly decisions = new Map<string, Promise<void>>();
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly job: DurableJobRecord,
    private readonly runtime: DurableJobRuntime,
    private readonly readProjectRevision: () => number | Promise<number> = () => job.projectRevision
  ) {}

  readonly onStatus = async (event: ToolExecutionStatusEvent): Promise<void> => {
    if (event.jobId !== this.job.id) throw new Error("Tool status belongs to a different durable job.");
    const decisionId = traceId("decision", this.job.id, executionIdFromAttempt(event.attemptId), event.decisionId);
    const attemptId = traceId("attempt", this.job.id, event.attemptId);
    await this.ensureDecision(event, decisionId);
    const previous = this.attempts.get(attemptId);
    const terminal = !["queued", "running"].includes(event.status);
    const attempt: StorageToolAttempt = {
      id: attemptId,
      projectId: this.job.projectId,
      jobId: this.job.id,
      decisionId,
      ordinal: event.ordinal,
      status: event.status,
      inputHash: durableJobRequestHash(event.inputs),
      outputHash: event.outputHash ?? previous?.attempt.outputHash,
      terminalCause: event.terminalCause,
      dependsOnAttemptIds: event.dependsOnAttemptIds ?? previous?.attempt.dependsOnAttemptIds ?? [],
      stagingRef: event.stagingRef,
      quarantineRef: event.quarantineRef,
      error: redactTraceText(event.error),
      queuedAt: previous?.attempt.queuedAt ?? event.occurredAt,
      startedAt: event.status === "running" ? event.occurredAt : previous?.attempt.startedAt,
      completedAt: terminal ? event.occurredAt : undefined,
      data: { phase: event.phase }
    };
    const outputs = event.outputs ?? previous?.outputs ?? [];
    this.attempts.set(attemptId, { attempt, toolName: event.toolName, outputs });
    await this.runtime.recordToolAttemptAndEvent({ attempt, projectRevision: await this.readProjectRevision(), toolName: event.toolName });
    if (event.status === "completed") await this.recordUnpromotedOutputs(attemptId, outputs, event.occurredAt);
    if (event.status === "completed" && event.codexCliTrace) {
      const trace = event.codexCliTrace;
      await this.runtime.saveCodexCliExecution({
        id: traceId("codex", attemptId),
        projectId: this.job.projectId,
        jobId: this.job.id,
        attemptId,
        model: trace.model,
        reasoningEffort: trace.reasoningEffort,
        sandboxProfile: trace.sandboxProfile,
        networkPolicy: "disabled",
        durationMs: trace.durationMs,
        exitCode: trace.exitCode,
        terminationReason: trace.terminationReason,
        eventCount: trace.eventCount,
        workspaceManifestHash: trace.workspaceManifestHash,
        outputManifestHash: trace.outputManifestHash,
        createdAt: previous?.attempt.startedAt ?? event.occurredAt,
        completedAt: event.occurredAt
      });
    }
  };

  async promoteCompletedOutputs(projectRevision: number): Promise<void> {
    const promotedAt = new Date().toISOString();
    for (const state of [...this.attempts.values()].sort((left, right) => left.attempt.ordinal - right.attempt.ordinal)) {
      if (state.attempt.status !== "completed") continue;
      for (const output of state.outputs) {
        const link = outputLink(this.job, state.attempt.id, output, true, promotedAt);
        if (output.kind === "artifact") {
          await this.runtime.recordPromotedArtifactAndEvent({
            link,
            projectRevision,
            artifact: { name: output.name ?? output.id, kind: output.artifactKind ?? "artifact" }
          });
        } else {
          await this.runtime.recordToolOutput(link);
        }
      }
    }
  }

  private async ensureDecision(event: ToolExecutionStatusEvent, decisionId: string): Promise<void> {
    const existing = this.decisions.get(decisionId);
    if (existing && event.policyStatus !== "rejected") return existing;
    const write = this.runtime
      .recordToolDecision({
        id: decisionId,
        projectId: this.job.projectId,
        jobId: this.job.id,
        toolName: event.toolName,
        purpose: event.purpose?.trim() || "Legacy untraced tool purpose.",
        expectedOutcome: event.expectedOutcome?.trim() || "Legacy untraced tool outcome.",
        rawSelection: { inputHash: durableJobRequestHash(event.inputs), inputs: sanitizeTraceRecord(event.inputs) },
        userPinned: false,
        policyStatus: event.policyStatus ?? "accepted",
        policyReason: redactTraceText(event.policyReason),
        compiledAction: { toolName: event.toolName, ordinal: event.ordinal, phase: event.phase, inputs: sanitizeTraceRecord(event.inputs) },
        createdAt: event.occurredAt
      })
      .then(() => undefined);
    this.decisions.set(decisionId, write);
    return write;
  }

  private async recordUnpromotedOutputs(attemptId: string, outputs: NonNullable<ToolExecutionStatusEvent["outputs"]>, createdAt: string): Promise<void> {
    for (const output of outputs) await this.runtime.recordToolOutput(outputLink(this.job, attemptId, output, false, createdAt));
  }
}

function outputLink(
  job: DurableJobRecord,
  attemptId: string,
  output: NonNullable<ToolExecutionStatusEvent["outputs"]>[number],
  promoted: boolean,
  timestamp: string
): StorageToolOutputLink {
  return {
    id: traceId("output", attemptId, output.kind, output.id),
    projectId: job.projectId,
    jobId: job.id,
    attemptId,
    outputKind: output.kind,
    outputId: output.id,
    promoted,
    createdAt: timestamp,
    ...(promoted ? { promotedAt: timestamp } : {})
  };
}

function traceId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function executionIdFromAttempt(attemptId: string): string {
  const separator = attemptId.lastIndexOf(":");
  return separator > 0 ? attemptId.slice(0, separator) : attemptId;
}
