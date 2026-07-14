import type { DatabaseSync } from "node:sqlite";
import { StorageOwnershipConflictError } from "./runStateErrors.js";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import type { Row } from "./repositorySupport.js";
import type { StorageRunOwnership } from "./runStateTypes.js";

const resumableStatuses = new Set(["paused", "interrupted", "blocked", "failed"]);

export class RunStateLineage {
  constructor(private readonly db: DatabaseSync) {}

  assertProject(projectId: string): void {
    if (!this.db.prepare("select 1 from projects_v2 where id=?").get(projectId)) throw new StorageOwnershipConflictError();
  }

  assertReadAccess(owner: StorageRunOwnership): void {
    const latestLink = this.latestLink(owner.runId);
    if (!latestLink) throw new StorageOwnershipConflictError();
    this.assertLinkScope(latestLink, owner);
    if (latestLink.job_id === owner.jobId) return;
    const existing = this.linkForJob(owner.jobId);
    if (existing) throw new StorageOwnershipConflictError();
    this.assertValidResume(owner, latestLink);
  }

  assertWriteEligibility(owner: StorageRunOwnership): void {
    this.assertProject(owner.projectId);
    const job = this.job(owner.jobId);
    if (!job || job.project_id !== owner.projectId) throw new StorageOwnershipConflictError();
    const latestLink = this.latestLink(owner.runId);
    const existing = this.linkForJob(owner.jobId);
    if (existing) {
      this.assertLinkScope(existing, owner);
      if (latestLink?.job_id !== owner.jobId) throw new StorageOwnershipConflictError();
      return;
    }
    if (!latestLink) {
      this.assertInitialJob(job);
      return;
    }
    this.assertLinkScope(latestLink, owner);
    this.assertValidResume(owner, latestLink);
  }

  ensureWriter(owner: StorageRunOwnership, linkedAtRevision: number, createdAt: string): void {
    this.assertWriteEligibility(owner);
    const latestLink = this.latestLink(owner.runId);
    const existing = this.linkForJob(owner.jobId);
    if (existing) return;
    if (!latestLink) {
      const initial = this.assertInitialJob(requiredRow(this.job(owner.jobId)));
      this.insertLink(owner, initial.predecessorJobId, null, linkedAtRevision, createdAt);
      return;
    }
    const resume = this.assertValidResume(owner, latestLink);
    this.insertLink(owner, String(latestLink.job_id), resume.checkpointId, linkedAtRevision, createdAt);
  }

  assertLinkedJob(projectId: string, runId: string, jobId: string): void {
    const row = this.linkForJob(jobId);
    if (!row || row.project_id !== projectId || row.run_id !== runId) throw new StorageOwnershipConflictError();
  }

  private assertValidResume(owner: StorageRunOwnership, predecessor: Row): { checkpointId: string | null } {
    const job = this.job(owner.jobId);
    const source = this.job(String(predecessor.job_id));
    if (!job || job.project_id !== owner.projectId || !source || source.project_id !== owner.projectId) throw new StorageOwnershipConflictError();
    const payload = parseObject(job.payload);
    const predecessorJobId = String(predecessor.job_id);
    if (payload.resumesJobId !== predecessorJobId) {
      throw new StorageOwnershipConflictError();
    }
    if (payload.resumeCheckpointId === undefined) {
      this.assertCheckpointFreeTakeover(owner, predecessor, job, source);
      return { checkpointId: null };
    }
    if (!resumableStatuses.has(String(source.status)) || typeof payload.resumeCheckpointId !== "string" || !payload.resumeCheckpointId) {
      throw new StorageOwnershipConflictError();
    }
    const checkpoint = this.db.prepare("select id,project_id,job_id,status from checkpoints where id=?").get(payload.resumeCheckpointId) as Row | undefined;
    if (!checkpoint || checkpoint.project_id !== owner.projectId || checkpoint.job_id !== predecessorJobId || checkpoint.status !== "committed") {
      throw new StorageOwnershipConflictError();
    }
    const latest = this.db
      .prepare(
        `select id from checkpoints where job_id=? and status='committed'
         order by committed_at desc,created_at desc,id desc limit 1`
      )
      .get(predecessorJobId) as Row | undefined;
    if (latest?.id !== checkpoint.id) throw new StorageOwnershipConflictError();
    return { checkpointId: String(checkpoint.id) };
  }

  private assertInitialJob(job: Row): { predecessorJobId: string | null } {
    const payload = parseObject(job.payload);
    if (payload.resumesJobId === undefined && payload.resumeCheckpointId === undefined) {
      return { predecessorJobId: null };
    }
    if (typeof payload.resumesJobId !== "string" || payload.resumeCheckpointId !== undefined) throw new StorageOwnershipConflictError();
    const predecessor = this.job(payload.resumesJobId);
    if (!predecessor || predecessor.project_id !== job.project_id || predecessor.operation !== "research_loop" || predecessor.status !== "interrupted") {
      throw new StorageOwnershipConflictError();
    }
    this.assertBootstrapSuccessor(job, predecessor);
    if (
      this.db.prepare("select 1 from checkpoints where job_id=? and status='committed' limit 1").get(String(predecessor.id)) ||
      this.db.prepare("select 1 from tool_attempts where job_id=? limit 1").get(String(predecessor.id))
    ) {
      throw new StorageOwnershipConflictError();
    }
    return { predecessorJobId: payload.resumesJobId };
  }

  private assertCheckpointFreeTakeover(owner: StorageRunOwnership, link: Row, job: Row, source: Row): void {
    if (source.status !== "interrupted" || link.link_kind !== "root" || link.predecessor_job_id !== null || link.resume_checkpoint_id !== null) {
      throw new StorageOwnershipConflictError();
    }
    this.assertBootstrapSuccessor(job, source);
    const checkpoint = this.db.prepare("select 1 from checkpoints where job_id=? and status='committed' limit 1").get(String(source.id));
    const attempt = this.db.prepare("select 1 from tool_attempts where job_id=? limit 1").get(String(source.id));
    const latest = this.db.prepare("select revision,data from run_state_revisions where run_id=? order by revision desc limit 1").get(owner.runId) as
      Row | undefined;
    if (checkpoint || attempt || !latest || (latest.revision !== 0 && latest.revision !== 1)) throw new StorageOwnershipConflictError();
    const state = parseObject(latest.data);
    const ready = latest.revision === 0 && state.status === "ready" && (state.currentNodeId === undefined || state.currentNodeId === null);
    const active = latest.revision === 1 && state.status === "running" && typeof state.currentNodeId === "string";
    if (
      (!ready && !active) ||
      !emptyArray(state.completedNodeReceipts) ||
      !emptyArray(state.blockedReasons) ||
      !emptyArray(state.decisions) ||
      state.terminalReceipt !== undefined
    ) {
      throw new StorageOwnershipConflictError();
    }
  }

  private assertBootstrapSuccessor(job: Row, predecessor: Row): void {
    const predecessorPayload = parseObject(predecessor.payload);
    if (predecessorPayload.resumesJobId !== undefined || predecessorPayload.resumeCheckpointId !== undefined) throw new StorageOwnershipConflictError();
    const request = parseNestedObject(predecessorPayload.request);
    const anchor = parseNestedObject(request.canonicalInitializationAnchor);
    const anchorKeys = ["contentHash", "immutablePolicy", "projectId", "schemaVersion", "taskLimits", "taskSource"];
    const anchorBody = {
      schemaVersion: anchor.schemaVersion,
      projectId: anchor.projectId,
      taskSource: anchor.taskSource,
      immutablePolicy: anchor.immutablePolicy,
      taskLimits: anchor.taskLimits
    };
    if (
      Object.keys(anchor).sort().join("\0") !== anchorKeys.join("\0") ||
      anchor.schemaVersion !== 1 ||
      anchor.projectId !== job.project_id ||
      typeof anchor.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(anchor.contentHash) ||
      storageCanonicalHasher.sha256Canonical(anchorBody) !== anchor.contentHash.toLowerCase() ||
      request.action !== "start" ||
      job.operation !== "research_loop" ||
      !sameJson(job.requested_capabilities, predecessor.requested_capabilities) ||
      !sameJson(job.effective_capabilities, predecessor.effective_capabilities) ||
      !sameJson(job.tool_policy, predecessor.tool_policy)
    ) {
      throw new StorageOwnershipConflictError();
    }
  }

  private insertLink(
    owner: StorageRunOwnership,
    predecessorJobId: string | null,
    checkpointId: string | null,
    linkedAtRevision: number,
    createdAt: string
  ): void {
    const lineageSequence = this.nextLineageSequence(owner.runId);
    const linkKind = predecessorJobId === null ? "root" : checkpointId === null ? "bootstrap" : "resume";
    this.db
      .prepare(
        `insert into run_job_links
         (run_id,project_id,job_id,predecessor_job_id,resume_checkpoint_id,link_kind,lineage_sequence,linked_at_revision,created_at)
         values (?,?,?,?,?,?,?,?,?)`
      )
      .run(owner.runId, owner.projectId, owner.jobId, predecessorJobId, checkpointId, linkKind, lineageSequence, linkedAtRevision, createdAt);
  }

  private latestLink(runId: string): Row | undefined {
    return this.db.prepare("select * from run_job_links where run_id=? order by lineage_sequence desc limit 1").get(runId) as Row | undefined;
  }

  private nextLineageSequence(runId: string): number {
    const row = this.db.prepare("select coalesce(max(lineage_sequence),0)+1 as next_sequence from run_job_links where run_id=?").get(runId) as Row | undefined;
    const value = row?.next_sequence;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new StorageOwnershipConflictError();
    return value;
  }

  private linkForJob(jobId: string): Row | undefined {
    return this.db.prepare("select * from run_job_links where job_id=?").get(jobId) as Row | undefined;
  }

  private job(jobId: string): Row | undefined {
    return this.db
      .prepare("select id,project_id,operation,status,payload,requested_capabilities,effective_capabilities,tool_policy from jobs where id=?")
      .get(jobId) as Row | undefined;
  }

  private assertLinkScope(row: Row, owner: Pick<StorageRunOwnership, "projectId" | "runId">): void {
    if (row.project_id !== owner.projectId || row.run_id !== owner.runId) throw new StorageOwnershipConflictError();
  }
}

function parseNestedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageOwnershipConflictError();
  return value as Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(JSON.parse(String(left))) === canonicalJson(JSON.parse(String(right)));
  } catch {
    throw new StorageOwnershipConflictError();
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredRow(value: Row | undefined): Row {
  if (!value) throw new StorageOwnershipConflictError();
  return value;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new StorageOwnershipConflictError();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StorageOwnershipConflictError();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StorageOwnershipConflictError) throw error;
    throw new StorageOwnershipConflictError();
  }
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}
