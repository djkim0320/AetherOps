import type { DurableJobRecord } from "./durableJobTypes.js";
import { CanonicalRunRuntimeError, type CanonicalRunOwner } from "./canonicalRunTypes.js";

const MAX_RESUME_DEPTH = 128;

interface DurableJobReader {
  get(jobId: string): Promise<DurableJobRecord | undefined>;
}

export interface ResolvedCanonicalRunLineage {
  owner: CanonicalRunOwner;
  rootJob: DurableJobRecord;
  jobs: DurableJobRecord[];
  bootstrapWithoutCheckpoint: boolean;
}

export async function resolveCanonicalRunLineage(reader: DurableJobReader, activeJob: DurableJobRecord): Promise<ResolvedCanonicalRunLineage> {
  assertResearchJob(activeJob);
  const newestFirst = [activeJob];
  const visited = new Set([activeJob.id]);
  let cursor = activeJob;
  let bootstrapWithoutCheckpoint = false;
  while (cursor.resumesJobId) {
    if (newestFirst.length >= MAX_RESUME_DEPTH) invalid("Canonical resume lineage exceeds its bounded depth.");
    const checkpointFreeBootstrap = !cursor.resumeCheckpointId;
    if (checkpointFreeBootstrap && newestFirst.length !== 1) invalid("Only a direct root successor can bootstrap without a checkpoint.");
    if (visited.has(cursor.resumesJobId)) invalid("Canonical resume lineage contains a cycle.");
    const predecessor = await reader.get(cursor.resumesJobId);
    if (!predecessor) invalid("Canonical resume lineage references a missing predecessor job.");
    assertResearchJob(predecessor);
    if (predecessor.projectId !== activeJob.projectId) ownership("Canonical resume lineage crosses project ownership.");
    if (checkpointFreeBootstrap) {
      if (predecessor.resumesJobId || predecessor.status !== "interrupted") {
        invalid("Checkpoint-free bootstrap requires a directly interrupted root job.");
      }
      bootstrapWithoutCheckpoint = true;
    }
    visited.add(predecessor.id);
    newestFirst.push(predecessor);
    cursor = predecessor;
  }
  if (cursor.resumeCheckpointId) invalid("Initial canonical job cannot contain a resume checkpoint.");
  const jobs = newestFirst.reverse();
  return {
    owner: { projectId: activeJob.projectId, runId: `run:${cursor.id}`, jobId: activeJob.id },
    rootJob: cursor,
    jobs,
    bootstrapWithoutCheckpoint
  };
}

function assertResearchJob(job: DurableJobRecord): void {
  if (job.kind !== "research_loop") invalid("Canonical run lineage accepts research-loop jobs only.");
  if (!job.id || !job.projectId) invalid("Canonical run lineage contains an incomplete job identity.");
  if (!job.resumesJobId && job.resumeCheckpointId) invalid("A non-resume job cannot carry a resume checkpoint.");
}

function invalid(message: string): never {
  throw new CanonicalRunRuntimeError("INVALID_CANONICAL_RUN_INPUT", message);
}

function ownership(message: string): never {
  throw new CanonicalRunRuntimeError("CANONICAL_RUN_OWNERSHIP_MISMATCH", message);
}
