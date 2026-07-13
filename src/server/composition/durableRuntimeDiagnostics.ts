import type { StorageTraceQueryDiagnosticSnapshot, StorageTransactionDiagnosticSnapshot } from "../runtime/storage/worker/storageRuntimeDiagnostics.js";
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

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
