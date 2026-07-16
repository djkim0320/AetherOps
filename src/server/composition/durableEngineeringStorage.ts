import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type {
  StorageActivateEngineeringBaselineInput,
  StorageActivateEngineeringBaselineResult,
  StorageActivateEngineeringBaselineTransactionResult,
  StorageEngineeringArtifactReadInput,
  StorageEngineeringArtifactReadback
} from "../runtime/storage/v2/engineeringBaselineTypes.js";
import type { StorageCapabilityAudit, StorageJobEvent, StorageLeaseFence } from "../runtime/storage/v2/types.js";
import type { StorageTerminalCasAbortResult, StorageTerminalCasClaim } from "../runtime/storage/v2/terminalCasStore.js";
import { jobAtomicId } from "../runtime/storage/v2/jobAtomicIds.js";
import type { StorageWorkerClient, StorageWorkerCommand } from "../runtime/storage/worker/typedRuntime.js";

type BaselineActivationCommand = Extract<StorageWorkerCommand, { name: "engineering.baseline.activate" }>;

export class DurableEngineeringStorage {
  constructor(
    private readonly client: StorageWorkerClient,
    private readonly assertWritable: () => void,
    private readonly publish: (event: StorageJobEvent) => void,
    private readonly activeFence: (jobId: string) => StorageLeaseFence
  ) {}

  async activateBaseline(
    input: StorageActivateEngineeringBaselineInput,
    snapshot: { projectRevision: number; snapshotVersion: number; capabilityAudits: StorageCapabilityAudit[] }
  ): Promise<StorageActivateEngineeringBaselineResult> {
    this.assertWritable();
    const command: BaselineActivationCommand = {
      name: "engineering.baseline.activate",
      input,
      expectedProjectRevision: snapshot.projectRevision,
      capabilityAudits: snapshot.capabilityAudits,
      event: {
        eventId: jobAtomicId("event", input.baseline.projectId, input.baseline.contentHash, "baseline-activated"),
        projectId: input.baseline.projectId,
        type: "project.snapshot.changed",
        createdAt: input.baseline.createdAt,
        payload: {
          projectRevision: snapshot.projectRevision,
          data: { snapshotVersion: snapshot.snapshotVersion, reason: "project_updated" }
        }
      }
    };
    let stored: StorageActivateEngineeringBaselineTransactionResult;
    try {
      stored = await this.client.request(command);
    } catch (activationError) {
      stored = await this.reconcileActivationResponse(command, activationError);
    }
    if (stored.publishEvent) this.publish(stored.event);
    return stored.activation;
  }

  private async reconcileActivationResponse(
    command: BaselineActivationCommand,
    activationError: unknown
  ): Promise<StorageActivateEngineeringBaselineTransactionResult> {
    let committedEvent: StorageJobEvent | undefined;
    try {
      committedEvent = await this.client.request({ name: "event.get", eventId: command.event.eventId as string });
    } catch {
      throw activationError;
    }
    if (!committedEvent) throw activationError;
    try {
      return await this.client.request(command);
    } catch (reconciliationError) {
      throw new AggregateError([activationError, reconciliationError], "Committed engineering baseline activation could not be reconciled.", {
        cause: reconciliationError
      });
    }
  }

  getBaseline(projectId: string, baselineId: string): Promise<ConfigurationBaseline | undefined> {
    return this.client.request({ name: "engineering.baseline.get", projectId, baselineId });
  }

  activeBaseline(projectId: string): Promise<ConfigurationBaseline | undefined> {
    return this.client.request({ name: "engineering.baseline.active", projectId });
  }

  listBaselines(projectId: string, limit = 100): Promise<ConfigurationBaseline[]> {
    return this.client.request({ name: "engineering.baseline.list", projectId, limit });
  }

  readArtifact(input: StorageEngineeringArtifactReadInput): Promise<StorageEngineeringArtifactReadback> {
    return this.client.request({ name: "engineering.artifact.read", input });
  }

  abortCasClaims(jobId: string, claims: readonly StorageTerminalCasClaim[]): Promise<StorageTerminalCasAbortResult> {
    this.assertWritable();
    return this.client.request({ name: "engineering.cas.abort", fence: this.activeFence(jobId), claims: [...claims] });
  }
}
