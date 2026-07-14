import { createHash } from "node:crypto";
import type { ToolExecutionStatusEvent } from "../../core/tools/researchToolTypes.js";
import { getToolDescriptor } from "../../core/tools/toolDescriptors.js";
import type { StorageOutputPromotion } from "../runtime/storage/v2/jobAtomicTypes.js";
import type { StorageToolAttempt, StorageToolOutputLink } from "../runtime/storage/v2/traceTypes.js";
import { assertToolAttemptOutputPromotionAllowed } from "../runtime/storage/v2/toolPostcondition.js";
import type { DurableJobRuntime } from "./durableJobRuntime.js";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { redactTraceText } from "../runtime/security/traceSanitizer.js";

interface AttemptState {
  attempt: StorageToolAttempt;
  toolName: string;
  outputs: NonNullable<ToolExecutionStatusEvent["outputs"]>;
  outputLinks: StorageToolOutputLink[];
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
    const descriptor = getToolDescriptor(event.toolName);
    const descriptorSideEffects = descriptor ? [...descriptor.sideEffects].sort() : undefined;
    const inputHash = durableJobRequestHash(event.inputs);
    const quarantiningCompletedAttempt = previous?.attempt.status === "completed" && event.status === "quarantined";
    const idempotencyKey =
      previous?.attempt.idempotencyKey ??
      durableJobRequestHash({
        version: "tool-attempt-idempotency-v1",
        projectId: this.job.projectId,
        toolName: descriptor?.name ?? event.toolName,
        descriptorVersion: descriptor?.version,
        inputHash
      });
    const mutatesExternalState = descriptorSideEffects?.some((effect) => effect === "filesystem" || effect === "process") === true;
    const sideEffectKey =
      previous?.attempt.sideEffectKey ??
      (mutatesExternalState
        ? durableJobRequestHash({
            version: "tool-side-effect-key-v1",
            projectId: this.job.projectId,
            toolName: descriptor?.name ?? event.toolName,
            descriptorVersion: descriptor?.version,
            inputHash
          })
        : undefined);
    const attempt: StorageToolAttempt = {
      id: attemptId,
      projectId: this.job.projectId,
      jobId: this.job.id,
      decisionId,
      ordinal: event.ordinal,
      status: event.status,
      inputHash,
      outputHash: event.outputHash ?? previous?.attempt.outputHash,
      traceVersion: 1,
      traceAvailability: "vnext",
      descriptorVersion: descriptor?.version,
      descriptorSideEffects,
      sideEffectKey,
      idempotencyKey,
      postconditionDisposition: previous?.attempt.postconditionDisposition,
      postconditionReceipt: previous?.attempt.postconditionReceipt,
      terminalCause: event.terminalCause,
      dependsOnAttemptIds: event.dependsOnAttemptIds ?? previous?.attempt.dependsOnAttemptIds ?? [],
      stagingRef: event.stagingRef,
      quarantineRef: event.quarantineRef,
      error: durableToolErrorCode(event),
      queuedAt: previous?.attempt.queuedAt ?? event.occurredAt,
      startedAt: event.status === "running" ? event.occurredAt : previous?.attempt.startedAt,
      completedAt: terminal ? event.occurredAt : undefined,
      data: quarantiningCompletedAttempt
        ? previous.attempt.data
        : {
            phase: event.phase,
            ...(event.outputBytes === undefined
              ? {}
              : { accounting: { version: 1, canonicalResultBytes: event.outputBytes, source: "canonical_result_utf8_v1" } })
          }
    };
    const outputs = event.outputs ?? previous?.outputs ?? [];
    const outputLinks =
      event.status === "completed" ? preserveOutputLinks(this.job, attemptId, outputs, event.occurredAt, previous?.outputLinks) : (previous?.outputLinks ?? []);
    this.attempts.set(attemptId, { attempt, toolName: event.toolName, outputs, outputLinks });
    const projectRevision = await this.readProjectRevision();
    await this.runtime.recordToolAttemptAndEvent({ attempt, projectRevision, toolName: event.toolName });
    if (event.status === "completed") await this.recordUnpromotedOutputs(outputLinks);
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
    if (event.status === "completed" && mutatesExternalState) {
      const verified = await this.runtime.verifyToolPostcondition({
        jobId: this.job.id,
        attemptId,
        projectRevision,
        verifiedAt: event.occurredAt
      });
      this.attempts.set(attemptId, { attempt: verified, toolName: event.toolName, outputs, outputLinks });
    }
  };

  completedOutputPromotions(promotedAt = new Date().toISOString()): StorageOutputPromotion[] {
    const promotions: StorageOutputPromotion[] = [];
    for (const state of [...this.attempts.values()].sort((left, right) => left.attempt.ordinal - right.attempt.ordinal)) {
      if (state.attempt.status !== "completed") continue;
      const outputs = new Map(state.outputs.map((output) => [outputIdentity(output.kind, output.id), output]));
      if (state.outputLinks.some((link) => link.outputKind !== "source")) assertToolAttemptOutputPromotionAllowed(state.attempt);
      for (const originalLink of state.outputLinks) {
        // A source is an untrusted observation until a later validation produces evidence.
        // Keep its durable origin link for audit, but never mark it as a promoted result.
        if (originalLink.outputKind === "source") continue;
        const output = outputs.get(outputIdentity(originalLink.outputKind, originalLink.outputId));
        if (!output) throw new Error(`Completed output metadata is missing for ${originalLink.id}.`);
        const link = { ...originalLink, promoted: true, promotedAt };
        promotions.push({
          link,
          ...(output.kind === "artifact" ? { artifact: { name: output.name ?? output.id, kind: output.artifactKind ?? "artifact" } } : {})
        });
      }
    }
    return promotions;
  }

  private async ensureDecision(event: ToolExecutionStatusEvent, decisionId: string): Promise<void> {
    const existing = this.decisions.get(decisionId);
    if (existing && event.policyStatus !== "rejected") return existing;
    const inputHash = durableJobRequestHash(event.inputs);
    const write = this.runtime
      .recordToolDecision({
        id: decisionId,
        projectId: this.job.projectId,
        jobId: this.job.id,
        toolName: event.toolName,
        purpose: event.purpose?.trim() || "Legacy untraced tool purpose.",
        expectedOutcome: event.expectedOutcome?.trim() || "Legacy untraced tool outcome.",
        rawSelection: { inputHash },
        userPinned: false,
        policyStatus: event.policyStatus ?? "accepted",
        policyReason: redactTraceText(event.policyReason),
        compiledAction: {
          toolName: event.toolName,
          ordinal: event.ordinal,
          phase: event.phase,
          inputHash,
          ...(event.toolName === "CodexCliTool" ? { outputDeclarations: event.inputs.outputs } : {})
        },
        createdAt: event.occurredAt
      })
      .then(() => undefined);
    this.decisions.set(decisionId, write);
    return write;
  }

  private async recordUnpromotedOutputs(links: StorageToolOutputLink[]): Promise<void> {
    for (const link of links) await this.runtime.recordToolOutput(link);
  }
}

function outputLink(
  job: DurableJobRecord,
  attemptId: string,
  output: NonNullable<ToolExecutionStatusEvent["outputs"]>[number],
  createdAt: string
): StorageToolOutputLink {
  return {
    id: traceId("output", attemptId, output.kind, output.id),
    projectId: job.projectId,
    jobId: job.id,
    attemptId,
    outputKind: output.kind,
    outputId: output.id,
    promoted: false,
    createdAt
  };
}

function preserveOutputLinks(
  job: DurableJobRecord,
  attemptId: string,
  outputs: NonNullable<ToolExecutionStatusEvent["outputs"]>,
  createdAt: string,
  previous: StorageToolOutputLink[] = []
): StorageToolOutputLink[] {
  const existing = new Map(previous.map((link) => [outputIdentity(link.outputKind, link.outputId), link]));
  return outputs.map((output) => existing.get(outputIdentity(output.kind, output.id)) ?? outputLink(job, attemptId, output, createdAt));
}

function outputIdentity(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

function traceId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function executionIdFromAttempt(attemptId: string): string {
  const separator = attemptId.lastIndexOf(":");
  return separator > 0 ? attemptId.slice(0, separator) : attemptId;
}

function durableToolErrorCode(event: ToolExecutionStatusEvent): string | undefined {
  if (!event.error) return undefined;
  if (event.policyStatus === "rejected") return "TOOL_POLICY_REJECTED";
  if (event.status === "blocked") return "TOOL_ACTION_BLOCKED";
  if (event.status === "interrupted") return "TOOL_EXECUTION_INTERRUPTED";
  if (event.status === "quarantined") return "TOOL_OUTPUT_QUARANTINED";
  return "TOOL_EXECUTION_FAILED";
}
