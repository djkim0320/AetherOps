import { vi } from "vitest";
import { defaultSettings } from "../../runtime/storage/settingsStore.js";
import type { RpcHandlerContext } from "./context.js";
import { CapabilityMutationGate } from "./capabilityMutationGate.js";

export function researchEnqueueContext(
  enqueue: ReturnType<typeof vi.fn>,
  findIdempotentReceipt: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): RpcHandlerContext {
  const snapshot = {
    project: {
      id: "project-1",
      goal: "Verify fail-closed execution.",
      topic: "Offline ownership",
      scope: "Local test data only",
      budget: "One bounded run",
      currentStep: "PLAN_RESEARCH",
      status: "idle",
      projectRoot: ".tmp/projects/project-1",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      autonomyPolicy: { allowAgent: true, allowCodeExecution: false, allowExternalSearch: false }
    },
    iterations: [],
    sessions: [],
    researchInputs: [],
    specifications: [],
    toolRuns: [],
    evidence: [],
    artifacts: []
  };
  const jobs = {
    enqueue,
    findIdempotentReceipt,
    getProjectRevision: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue({ ...job("project-1", 1), engineeringBaseline: null }),
    engineering: { activeBaseline: vi.fn().mockResolvedValue(undefined) },
    recordCapabilityAudits: vi.fn().mockResolvedValue(undefined),
    commitProjectSnapshot: vi.fn(async (input: { project: { id: string }; expectedProjectRevision: number; occurredAt: string; reason: string }) => {
      const projectRevision = input.expectedProjectRevision + 1;
      return {
        event: {
          id: projectRevision,
          projectId: input.project.id,
          projectRevision,
          type: "project.snapshot.changed" as const,
          occurredAt: input.occurredAt,
          data: { snapshotVersion: projectRevision, reason: input.reason }
        },
        projectRevision,
        projectionHash: "a".repeat(64),
        exactReplay: false
      };
    })
  };
  const getSnapshot = vi.fn().mockResolvedValue(snapshot);
  const projectMutations = readableProjectMutations(snapshot);
  projectMutations.readSnapshot.mockImplementation(async (projectId: string) => ({
    snapshot: await getSnapshot(projectId),
    projectRevision: await jobs.getProjectRevision(projectId)
  }));
  return {
    capabilityMutations: new CapabilityMutationGate(),
    orchestrator: {
      getSnapshot
    },
    settingsStore: { getRuntimeSettings: vi.fn().mockResolvedValue(defaultSettings) },
    projectMutations,
    jobs,
    events: jobs
  } as unknown as RpcHandlerContext;
}

export function readableProjectMutations(snapshot?: unknown) {
  return {
    assertReadable: vi.fn(),
    assertAllReadable: vi.fn(),
    assertRevisionUnchanged: vi.fn().mockResolvedValue(undefined),
    readSnapshot: vi.fn().mockResolvedValue(snapshot === undefined ? undefined : { snapshot, projectRevision: 1 }),
    create: vi.fn(),
    update: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn()
  };
}

export function job(projectId: string, projectRevision: number) {
  return {
    id: "job-1",
    projectId,
    kind: "research_loop" as const,
    status: "running" as const,
    projectRevision,
    currentStep: "PLAN_RESEARCH" as const,
    idempotencyKey: "job-key",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}
