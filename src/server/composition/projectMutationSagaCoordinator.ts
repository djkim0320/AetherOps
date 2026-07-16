import type { CapabilitySet } from "../../contracts/api-v2/capabilities.js";
import type { ProjectInput } from "../../contracts/api-v2/projects.js";
import { countChatSessions } from "../../core/orchestration/chatProgress.js";
import type { ResearchProject, ResearchSession, ResearchSnapshot } from "../../core/shared/types.js";
import type { LegacyProjectMutationCommand, LegacyProjectMutationPort } from "../runtime/storage/legacyProjectMutationTypes.js";
import { legacyProjectSnapshotHash } from "../runtime/storage/legacyProjectMutationHash.js";
import type { StorageProjectMutationJournal, StorageProjectMutationMethod } from "../runtime/storage/v2/projectMutationTypes.js";
import type { StorageProjectRevisionHead } from "../runtime/storage/v2/projectRevisionRepository.js";
import { IdempotencyConflictError } from "../runtime/storage/v2/jobErrors.js";
import { StorageRevisionConflictError } from "../runtime/storage/v2/runStateErrors.js";
import type { StorageJsonObject } from "../runtime/storage/v2/types.js";
import { durableJobRequestHash } from "./durableJobRequestHash.js";
import { durableProjectSnapshotEventId } from "./durableSseEventIdentity.js";
import type { DurableProjectMutationStorage } from "./durableProjectMutationStorage.js";
import {
  commandEnvelope,
  createProject,
  finalizedResult,
  latestTimestamp,
  legacyRequest,
  newMutation,
  operationId,
  stableEntityId,
  timestampAfter,
  validRevisionHead,
  type NewMutation,
  type NewMutationIdentity
} from "./projectMutationSagaSupport.js";

export interface ProjectMutationSagaDependencies {
  operational: DurableProjectMutationStorage;
  legacy: LegacyProjectMutationPort;
  getSnapshot(projectId: string): Promise<ResearchSnapshot>;
  getProjectRevisionHead(projectId: string): Promise<StorageProjectRevisionHead | undefined>;
  projectRootBase: string;
  resultMapper: {
    project(snapshot: ResearchSnapshot, projectRevision: number): StorageJsonObject;
    session(session: ResearchSession): StorageJsonObject;
    deleted(): StorageJsonObject;
  };
  now?: () => string;
}

export class ProjectMutationPendingError extends Error {
  readonly code = "PROJECT_MUTATION_PENDING";

  constructor(readonly projectId: string) {
    super("The project has a durable mutation awaiting finalization.");
    this.name = "ProjectMutationPendingError";
  }
}

export class ProjectMutationNotReadyError extends Error {
  // Keep the established API-v2 reason while moving reads behind the saga.
  readonly code = "PROJECT_REVISION_UNAVAILABLE";

  constructor(readonly projectId: string) {
    super("The durable project revision is unavailable for a project mutation.");
    this.name = "ProjectMutationNotReadyError";
  }
}

export class ProjectMutationTargetNotFoundError extends Error {
  readonly code = "PROJECT_MUTATION_TARGET_NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "ProjectMutationTargetNotFoundError";
  }
}

export class ProjectMutationReadRaceError extends Error {
  readonly code = "PROJECT_SNAPSHOT_CHANGED";

  constructor(readonly projectId: string) {
    super("The project changed while its snapshot was being read. Refresh and retry.");
    this.name = "ProjectMutationReadRaceError";
  }
}

export class ProjectMutationSagaCoordinator {
  private readonly pendingOperations = new Map<string, string>();
  private readonly inFlight = new Map<string, { requestHash: string; result: Promise<StorageJsonObject> }>();

  constructor(private readonly dependencies: ProjectMutationSagaDependencies) {}

  async recoverPending(): Promise<void> {
    const pending = await this.dependencies.operational.listPending();
    for (const journal of pending) this.pendingOperations.set(journal.projectId, journal.operationId);
    const failures: unknown[] = [];
    for (const journal of pending) {
      try {
        await this.finish(journal);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Multiple pending project mutations could not be recovered.");
  }

  assertReadable(projectId: string): void {
    if (this.pendingOperations.has(projectId)) throw new ProjectMutationPendingError(projectId);
  }

  assertAllReadable(): void {
    const projectId = [...this.pendingOperations.keys()].sort()[0];
    if (projectId) throw new ProjectMutationPendingError(projectId);
  }

  async readSnapshot(projectId: string): Promise<{ snapshot: ResearchSnapshot; projectRevision: number }> {
    const [snapshot, head] = await this.readStableProject(projectId);
    return { snapshot, projectRevision: head.revision };
  }

  async assertRevisionUnchanged(projectId: string, expectedRevision: number): Promise<void> {
    this.assertReadable(projectId);
    const head = await this.dependencies.getProjectRevisionHead(projectId);
    this.assertReadable(projectId);
    if (!validRevisionHead(head)) throw new ProjectMutationNotReadyError(projectId);
    if (head.revision !== expectedRevision) throw new ProjectMutationReadRaceError(projectId);
  }

  create(requestId: string, input: ProjectInput): Promise<StorageJsonObject> {
    return this.execute("projects.create", requestId, { input }, async (identity) => {
      const project = createProject(identity.operationId, identity.preparedAt, input, this.dependencies.projectRootBase);
      return newMutation(identity, project.id, 0, null, "project.create", { project });
    });
  }

  update(
    requestId: string,
    projectId: string,
    expectedProjectRevision: number,
    input: Partial<ProjectInput>,
    capabilities?: Partial<CapabilitySet>
  ): Promise<StorageJsonObject> {
    return this.execute("projects.update", requestId, { projectId, expectedRevision: expectedProjectRevision, input, capabilities }, async (identity) => {
      const [snapshot, head] = await this.currentSnapshot(projectId, expectedProjectRevision);
      const appliedAt = timestampAfter(identity.preparedAt, latestTimestamp(snapshot.project.updatedAt, head.updatedAt));
      const project: ResearchProject = {
        ...snapshot.project,
        ...input,
        autonomyPolicy: {
          ...snapshot.project.autonomyPolicy,
          allowAgent: capabilities?.agent ?? snapshot.project.autonomyPolicy.allowAgent ?? true,
          allowCodeExecution: capabilities?.engineering ?? snapshot.project.autonomyPolicy.allowCodeExecution,
          allowExternalSearch: capabilities?.search ?? snapshot.project.autonomyPolicy.allowExternalSearch
        },
        updatedAt: appliedAt
      };
      return newMutation({ ...identity, preparedAt: appliedAt }, projectId, expectedProjectRevision, legacyProjectSnapshotHash(snapshot), "project.update", {
        project
      });
    });
  }

  createSession(requestId: string, projectId: string, title?: string, focus?: string): Promise<StorageJsonObject> {
    return this.execute("sessions.create", requestId, { projectId, title, focus }, async (identity) => {
      const [snapshot, head] = await this.currentProject(projectId);
      const appliedAt = timestampAfter(
        identity.preparedAt,
        latestTimestamp(snapshot.project.updatedAt, head.updatedAt, ...snapshot.sessions.map((item) => item.createdAt))
      );
      const session: ResearchSession = {
        id: stableEntityId("session", identity.operationId),
        projectId,
        title: title?.trim() || `채팅 세션 ${countChatSessions(snapshot.sessions) + 1}`,
        focus: focus?.trim() || `${snapshot.project.topic} 관련 연구 대화 세션입니다.`,
        createdAt: appliedAt
      };
      return newMutation({ ...identity, preparedAt: appliedAt }, projectId, head.revision, legacyProjectSnapshotHash(snapshot), "session.create", { session });
    });
  }

  deleteSession(requestId: string, projectId: string, sessionId: string): Promise<StorageJsonObject> {
    return this.execute("sessions.delete", requestId, { projectId, sessionId }, async (identity) => {
      const [snapshot, head] = await this.currentProject(projectId);
      if (!snapshot.sessions.some((session) => session.id === sessionId)) {
        throw new ProjectMutationTargetNotFoundError("Session not found.");
      }
      const appliedAt = timestampAfter(
        identity.preparedAt,
        latestTimestamp(snapshot.project.updatedAt, head.updatedAt, ...snapshot.sessions.map((item) => item.createdAt))
      );
      return newMutation({ ...identity, preparedAt: appliedAt }, projectId, head.revision, legacyProjectSnapshotHash(snapshot), "session.delete", {
        sessionId
      });
    });
  }

  private async execute(
    method: StorageProjectMutationMethod,
    requestId: string,
    params: unknown,
    build: (identity: NewMutationIdentity) => Promise<NewMutation>
  ): Promise<StorageJsonObject> {
    const requestHash = durableJobRequestHash({ method, params });
    const inFlightKey = `${method}\0${requestId}`;
    const inFlight = this.inFlight.get(inFlightKey);
    if (inFlight) {
      if (inFlight.requestHash !== requestHash) throw new IdempotencyConflictError();
      return inFlight.result;
    }
    const result = this.executeOnce(method, requestId, requestHash, build);
    this.inFlight.set(inFlightKey, { requestHash, result });
    try {
      return await result;
    } finally {
      if (this.inFlight.get(inFlightKey)?.result === result) this.inFlight.delete(inFlightKey);
    }
  }

  private async executeOnce(
    method: StorageProjectMutationMethod,
    requestId: string,
    requestHash: string,
    build: (identity: NewMutationIdentity) => Promise<NewMutation>
  ): Promise<StorageJsonObject> {
    const existing = await this.dependencies.operational.lookup(method, requestId, requestHash);
    if (existing) {
      const responseWasLost = existing.state === "finalized" && this.pendingOperations.get(existing.projectId) === existing.operationId;
      return existing.state === "finalized" && !responseWasLost ? finalizedResult(existing) : this.finish(existing);
    }
    const identity = {
      operationId: operationId(method, requestId),
      method,
      requestId,
      requestHash,
      preparedAt: this.now()
    };
    const mutation = await build(identity);
    this.reservePending(mutation.projectId, mutation.operationId);
    let prepared: Awaited<ReturnType<DurableProjectMutationStorage["prepare"]>>;
    try {
      prepared = await this.dependencies.operational.prepare({
        method,
        requestId,
        requestHash,
        projectId: mutation.projectId,
        expectedProjectRevision: mutation.expectedProjectRevision,
        command: commandEnvelope(mutation),
        legacyBeforeHash: mutation.legacyBeforeHash ?? durableJobRequestHash(null),
        preparedAt: mutation.preparedAt
      });
    } catch (error) {
      return this.reconcilePrepareFailure(mutation, error);
    }
    return this.finish(prepared.journal);
  }

  private reservePending(projectId: string, operationId: string): void {
    const pendingOperationId = this.pendingOperations.get(projectId);
    if (pendingOperationId && pendingOperationId !== operationId) throw new ProjectMutationPendingError(projectId);
    this.pendingOperations.set(projectId, operationId);
  }

  private async reconcilePrepareFailure(mutation: NewMutation, prepareError: unknown): Promise<StorageJsonObject> {
    try {
      // Storage worker commands are FIFO. A lookup that completes after an
      // uncertain prepare response authoritatively observes its commit or absence.
      const journal = await this.dependencies.operational.lookup(mutation.method, mutation.requestId, mutation.requestHash);
      if (journal) return this.finish(journal);
      if (this.pendingOperations.get(mutation.projectId) === mutation.operationId) this.pendingOperations.delete(mutation.projectId);
    } catch (reconciliationError) {
      if (reconciliationError instanceof IdempotencyConflictError) {
        if (this.pendingOperations.get(mutation.projectId) === mutation.operationId) this.pendingOperations.delete(mutation.projectId);
      }
      // Keep the in-memory barrier fail-closed when authoritative reconciliation
      // is unavailable. An exact retry or process restart will recover the journal.
    }
    throw prepareError;
  }

  private async finish(journal: StorageProjectMutationJournal): Promise<StorageJsonObject> {
    this.pendingOperations.set(journal.projectId, journal.operationId);
    const request = legacyRequest(journal);
    const applied = await this.dependencies.legacy.apply(request);
    if (journal.state === "prepared") {
      journal = (
        await this.dependencies.operational.markLegacyApplied({
          operationId: journal.operationId,
          legacyReceiptHash: applied.receipt.receiptHash,
          snapshotHash: applied.receipt.snapshotHash,
          appliedAt: applied.receipt.appliedAt
        })
      ).journal;
    } else if (
      journal.legacyReceiptHash !== applied.receipt.receiptHash ||
      journal.legacySnapshotHash !== applied.receipt.snapshotHash ||
      journal.legacyAppliedAt !== applied.receipt.appliedAt
    ) {
      throw new Error("The operational project mutation journal does not match legacy receipt readback.");
    }
    const publicResult = this.publicResult(journal, applied.snapshot, request.command);
    const snapshotHash = legacyProjectSnapshotHash(applied.snapshot);
    if (snapshotHash !== applied.receipt.snapshotHash) throw new Error("Legacy project mutation snapshot readback hash changed before finalization.");
    const finalized = await this.finalizeWithReconciliation(journal, {
      operationId: journal.operationId,
      project: applied.snapshot.project,
      eventId: durableProjectSnapshotEventId({
        projectId: journal.projectId,
        reason: "project_updated",
        snapshotContentHash: snapshotHash,
        snapshotUpdatedAt: applied.snapshot.project.updatedAt,
        callerMutationId: journal.requestId
      }),
      snapshotHash,
      occurredAt: applied.receipt.appliedAt,
      publicResult,
      publicResultHash: durableJobRequestHash(publicResult)
    });
    if (this.pendingOperations.get(journal.projectId) === journal.operationId) this.pendingOperations.delete(journal.projectId);
    return finalized.publicResult;
  }

  private async finalizeWithReconciliation(
    journal: StorageProjectMutationJournal,
    input: Parameters<DurableProjectMutationStorage["finalize"]>[0]
  ): ReturnType<DurableProjectMutationStorage["finalize"]> {
    try {
      return await this.dependencies.operational.finalize(input);
    } catch (finalizeError) {
      try {
        // A FIFO lookup runs after the uncertain command and distinguishes a
        // committed response loss from a finalize that never committed.
        const readback = await this.dependencies.operational.lookup(journal.method, journal.requestId, journal.requestHash);
        if (readback?.state === "finalized") return this.dependencies.operational.finalize(input);
      } catch {
        // Keep the project barrier fail-closed until an exact retry or restart.
      }
      throw finalizeError;
    }
  }

  private publicResult(journal: StorageProjectMutationJournal, snapshot: ResearchSnapshot, command: LegacyProjectMutationCommand): StorageJsonObject {
    if (journal.method === "projects.create" || journal.method === "projects.update") {
      return this.dependencies.resultMapper.project(snapshot, journal.expectedProjectRevision + 1);
    }
    if (journal.method === "sessions.delete") return this.dependencies.resultMapper.deleted();
    const sessionId = "session" in command ? command.session.id : undefined;
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error("Committed legacy session mutation is missing its session readback.");
    return this.dependencies.resultMapper.session(session);
  }

  private async currentSnapshot(projectId: string, expectedRevision: number): Promise<[ResearchSnapshot, StorageProjectRevisionHead]> {
    this.assertReadable(projectId);
    const [snapshot, head] = await this.currentProject(projectId);
    if (head.revision !== expectedRevision) throw new StorageRevisionConflictError(expectedRevision, head.revision);
    return [snapshot, head];
  }

  private async currentProject(projectId: string): Promise<[ResearchSnapshot, StorageProjectRevisionHead]> {
    return this.readStableProject(projectId);
  }

  private async readStableProject(projectId: string): Promise<[ResearchSnapshot, StorageProjectRevisionHead]> {
    this.assertReadable(projectId);
    const before = await this.dependencies.getProjectRevisionHead(projectId);
    let snapshot: ResearchSnapshot;
    try {
      snapshot = await this.dependencies.getSnapshot(projectId);
    } catch (error) {
      if (error instanceof Error && /^Research project not found:/.test(error.message)) {
        throw new ProjectMutationTargetNotFoundError("Project not found.");
      }
      throw error;
    }
    const head = await this.dependencies.getProjectRevisionHead(projectId);
    this.assertReadable(projectId);
    if (!validRevisionHead(before) || !validRevisionHead(head)) {
      throw new ProjectMutationNotReadyError(projectId);
    }
    if (before.revision !== head.revision || before.lastReceiptId !== head.lastReceiptId) throw new ProjectMutationReadRaceError(projectId);
    return [snapshot, head];
  }

  private now(): string {
    const value = this.dependencies.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) throw new Error("Project mutation clock returned an invalid timestamp.");
    return value;
  }
}
