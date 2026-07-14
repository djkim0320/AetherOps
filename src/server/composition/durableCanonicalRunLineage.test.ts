import { describe, expect, it } from "vitest";
import type { DurableJobRecord } from "./durableJobTypes.js";
import { resolveCanonicalRunLineage } from "./durableCanonicalRunLineage.js";
import { CanonicalRunRuntimeError } from "./canonicalRunTypes.js";

const T0 = "2026-07-14T00:00:00.000Z";

describe("resolveCanonicalRunLineage", () => {
  it("keeps a stable root run id while assigning writes to the active resume job", async () => {
    const root = job("job-root", {});
    const firstResume = job("job-resume-1", { resumesJobId: root.id, resumeCheckpointId: "checkpoint-1" });
    const active = job("job-resume-2", { resumesJobId: firstResume.id, resumeCheckpointId: "checkpoint-2" });
    const jobs = new Map([root, firstResume].map((item) => [item.id, item]));

    const resolved = await resolveCanonicalRunLineage({ get: async (id) => jobs.get(id) }, active);

    expect(resolved.owner).toEqual({ projectId: "project-1", runId: "run:job-root", jobId: "job-resume-2" });
    expect(resolved.jobs.map((item) => item.id)).toEqual(["job-root", "job-resume-1", "job-resume-2"]);
    expect(resolved.rootJob).toEqual(root);
    expect(resolved.bootstrapWithoutCheckpoint).toBe(false);
  });

  it("accepts only a direct successor of an interrupted root as checkpoint-free bootstrap lineage", async () => {
    const root = job("job-bootstrap-root", { status: "interrupted" });
    const active = job("job-bootstrap-resume", { resumesJobId: root.id });

    const resolved = await resolveCanonicalRunLineage({ get: async (id) => (id === root.id ? root : undefined) }, active);

    expect(resolved.owner).toEqual({ projectId: "project-1", runId: `run:${root.id}`, jobId: active.id });
    expect(resolved.bootstrapWithoutCheckpoint).toBe(true);
  });

  it("rejects missing checkpoints, cycles, missing predecessors, and cross-project chains", async () => {
    const root = job("job-root", {});
    const cases: Array<{ active: DurableJobRecord; records: DurableJobRecord[]; code: CanonicalRunRuntimeError["code"] }> = [
      { active: job("missing-checkpoint", { resumesJobId: root.id }), records: [root], code: "INVALID_CANONICAL_RUN_INPUT" },
      {
        active: job("cycle-a", { resumesJobId: "cycle-b", resumeCheckpointId: "checkpoint-a" }),
        records: [job("cycle-b", { resumesJobId: "cycle-a", resumeCheckpointId: "checkpoint-b" })],
        code: "INVALID_CANONICAL_RUN_INPUT"
      },
      { active: job("missing", { resumesJobId: "absent", resumeCheckpointId: "checkpoint-missing" }), records: [], code: "INVALID_CANONICAL_RUN_INPUT" },
      {
        active: job("cross-project", { resumesJobId: "foreign", resumeCheckpointId: "checkpoint-cross" }),
        records: [job("foreign", { projectId: "project-2" })],
        code: "CANONICAL_RUN_OWNERSHIP_MISMATCH"
      }
    ];

    for (const testCase of cases) {
      const records = new Map(testCase.records.map((item) => [item.id, item]));
      await expect(resolveCanonicalRunLineage({ get: async (id) => records.get(id) }, testCase.active)).rejects.toMatchObject<
        Partial<CanonicalRunRuntimeError>
      >({ code: testCase.code });
    }
  });
});

function job(id: string, overrides: Partial<DurableJobRecord>): DurableJobRecord {
  return {
    id,
    projectId: "project-1",
    kind: "research_loop",
    status: "running",
    projectRevision: 1,
    idempotencyKey: id,
    requestedCapabilities: { agent: true, engineering: false, search: false },
    effectiveCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } },
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
}
