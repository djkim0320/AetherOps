import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type {
  StorageOperationalDiagnosticSnapshot,
  StorageTraceQueryDiagnosticSnapshot,
  StorageTransactionDiagnosticSnapshot
} from "../runtime/storage/worker/storageRuntimeDiagnostics.js";
import type { StorageJobQueueDiagnostics } from "../runtime/storage/v2/types.js";
import type { SseRuntimeDiagnosticSnapshot } from "./sseRuntimeDiagnostics.js";

export interface DurableRuntimeDiagnosticSnapshot {
  activeProjectCount: number;
  activeJobCount: number;
  leaseRenewalSuccessCount: number;
  leaseRenewalFailureCount: number;
  leaseLostCount: number;
  staleWriteRejectionCount: number;
  recoveryScannedProjectCount: number;
}

export interface DurableQueuedProjectDiagnostic {
  projectId: string;
  depth: number;
  oldestQueuedAt: string;
  oldestQueuedAgeMs: number;
}

export interface DurableOperationalDiagnosticSnapshot {
  generatedAt: string;
  countersSince: string;
  runtime: DurableRuntimeDiagnosticSnapshot;
  sse: SseRuntimeDiagnosticSnapshot;
  traceQueries: StorageTraceQueryDiagnosticSnapshot;
  storageTransactions: StorageTransactionDiagnosticSnapshot;
  queue: {
    projects: DurableQueuedProjectDiagnostic[];
    totalDepth: number;
    oldestQueuedAt?: string;
    oldestQueuedAgeMs?: number;
    totalProjects: number;
    truncated: boolean;
  };
}

/** Process-local, bounded counters. IDs and user content are never retained. */
export class DurableRuntimeDiagnostics {
  private activeProjects = 0;
  private activeJobs = 0;
  private renewalsSucceeded = 0;
  private renewalsFailed = 0;
  private leasesLost = 0;
  private staleWritesRejected = 0;
  private recoveryProjects = 0;

  setActiveProjects(projects: number): void {
    this.activeProjects = nonnegative(projects);
  }

  setActiveJobs(jobs: number): void {
    this.activeJobs = nonnegative(jobs);
  }

  recordRenewal(success: boolean): void {
    if (success) this.renewalsSucceeded += 1;
    else this.renewalsFailed += 1;
  }

  recordLeaseLost(): void {
    this.leasesLost += 1;
  }

  recordStaleWriteRejection(): void {
    this.staleWritesRejected += 1;
  }

  recordRecoveryProjects(count: number): void {
    this.recoveryProjects += nonnegative(count);
  }

  snapshot(): DurableRuntimeDiagnosticSnapshot {
    return {
      activeProjectCount: this.activeProjects,
      activeJobCount: this.activeJobs,
      leaseRenewalSuccessCount: this.renewalsSucceeded,
      leaseRenewalFailureCount: this.renewalsFailed,
      leaseLostCount: this.leasesLost,
      staleWriteRejectionCount: this.staleWritesRejected,
      recoveryScannedProjectCount: this.recoveryProjects
    };
  }
}

interface CollectDurableOperationalDiagnosticsInput {
  client: StorageWorkerClient;
  countersSince: string;
  runtime: DurableRuntimeDiagnosticSnapshot;
  sse: SseRuntimeDiagnosticSnapshot;
  sampledAtMs: number;
  queueProjectLimit: number;
}

export async function collectDurableOperationalDiagnostics(input: CollectDurableOperationalDiagnosticsInput): Promise<DurableOperationalDiagnosticSnapshot> {
  const [queue, storage] = await Promise.all([
    input.client.request<StorageJobQueueDiagnostics>({ name: "job.queueDiagnostics", limit: input.queueProjectLimit }),
    input.client.request<StorageOperationalDiagnosticSnapshot>({ name: "diagnostics.storage" })
  ]);
  return {
    generatedAt: new Date(input.sampledAtMs).toISOString(),
    countersSince: input.countersSince,
    runtime: input.runtime,
    sse: input.sse,
    traceQueries: storage.traceQueries,
    storageTransactions: storage.storageTransactions,
    queue: {
      projects: queue.projects.map((project) => ({
        ...project,
        oldestQueuedAgeMs: queuedAgeMs(project.oldestQueuedAt, input.sampledAtMs)
      })),
      totalDepth: queue.totalDepth,
      ...(queue.oldestQueuedAt ? { oldestQueuedAt: queue.oldestQueuedAt, oldestQueuedAgeMs: queuedAgeMs(queue.oldestQueuedAt, input.sampledAtMs) } : {}),
      totalProjects: queue.totalProjects,
      truncated: queue.truncated
    }
  };
}

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function queuedAgeMs(queuedAt: string, sampledAtMs: number): number {
  const queuedAtMs = Date.parse(queuedAt);
  if (!Number.isFinite(queuedAtMs)) throw new Error("Durable queue diagnostics returned an invalid queued timestamp.");
  return Math.max(0, Math.floor(sampledAtMs - queuedAtMs));
}
