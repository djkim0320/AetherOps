import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { DurableToolExecutionAdapter } from "./durableToolExecutionAdapter.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("DurableToolExecutionAdapter", () => {
  it("fences tool lifecycle and promotes completed outputs atomically with job completion", async () => {
    const databasePath = createDatabase();
    let clockMs = Date.parse("2026-07-14T00:00:00.000Z");
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, clock: { now: () => clockMs } });
    const now = new Date(clockMs).toISOString();
    const completedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const promotedAt = new Date(Date.parse(now) + 2_000).toISOString();
    let observedUnpromoted = false;
    runtime.registerHandler("research_loop", async (job) => {
      const adapter = new DurableToolExecutionAdapter(job, runtime as DurableJobRuntime);
      const artifact = action(job.id, now, "execution-1:action-1", "intent-1", 0, "ArtifactWriterTool", "artifact");
      await adapter.onStatus({ ...artifact, status: "queued" });
      await adapter.onStatus({ ...artifact, status: "running" });
      await adapter.onStatus({
        ...artifact,
        status: "completed",
        occurredAt: completedAt,
        outputIds: ["tool-run-1", "artifact-1"],
        outputs: [{ id: "artifact-1", kind: "artifact", name: "Report", artifactKind: "generated_artifact" }]
      });
      observedUnpromoted =
        (await runtime?.getDetail(job.id))?.trace.outputs.some(
          (output) => output.outputId === "artifact-1" && !output.promoted && output.createdAt === completedAt
        ) === true;

      const denied = action(job.id, now, "execution-1:action-2", "intent-2", 1, "WebFetchTool", "acquisition.fetch");
      await adapter.onStatus({ ...denied, status: "queued" });
      await adapter.onStatus({
        ...denied,
        status: "blocked",
        policyStatus: "rejected",
        policyReason: "Search was revoked after enqueue.",
        error: "Search was revoked after enqueue."
      });

      const codex = action(job.id, now, "execution-1:action-3", "intent-3", 2, "CodexCliTool", "exclusive");
      await adapter.onStatus({ ...codex, status: "queued" });
      await adapter.onStatus({ ...codex, status: "running" });
      await adapter.onStatus({
        ...codex,
        status: "completed",
        codexCliTrace: {
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandboxProfile: "aetherops-codex-workspace-v1",
          networkPolicy: "disabled",
          durationMs: 10,
          exitCode: 0,
          eventCount: 3,
          workspaceManifestHash: "a".repeat(64),
          outputManifestHash: "b".repeat(64),
          terminationReason: "completed"
        }
      });
      clockMs = Date.parse(promotedAt);
      await runtime?.finish(job.id, 5, adapter.completedOutputPromotions(promotedAt));
    });
    await runtime.initialize();
    const receipt = await runtime.enqueue({
      projectId: "project-1",
      kind: "research_loop",
      projectRevision: 4,
      idempotencyKey: "key-1",
      requestHash: "request-hash",
      payload: {}
    });
    await waitForStatus(receipt.jobId, "completed");

    expect(observedUnpromoted).toBe(true);
    const events = await runtime.eventsAfter("project-1");
    expect(events.filter((event) => event.type === "tool.run.changed")).toHaveLength(8);
    expect(events.filter((event) => event.type === "artifact.created")).toMatchObject([
      { data: { jobId: receipt.jobId, artifactId: "artifact-1", name: "Report", kind: "generated_artifact" } }
    ]);
    const detail = await runtime.getDetail(receipt.jobId);
    expect(detail?.trace.outputs).toEqual(
      expect.arrayContaining([expect.objectContaining({ outputId: "artifact-1", promoted: true, createdAt: completedAt, promotedAt })])
    );
    expect(detail?.trace.toolDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "WebFetchTool", policyStatus: "rejected" })]));
    expect(detail?.trace.codexCliExecutions).toMatchObject([
      { model: "gpt-5.6-sol", reasoningEffort: "high", networkPolicy: "disabled", outputManifestHash: "b".repeat(64) }
    ]);
  });
});

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-tool-trace-"));
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db);
  db.close();
  return databasePath;
}

function action(jobId: string, occurredAt: string, attemptId: string, decisionId: string, ordinal: number, toolName: string, phase: string) {
  return {
    signal: new AbortController().signal,
    jobId,
    attemptId,
    decisionId,
    ordinal,
    phase: phase as "artifact",
    inputs: {},
    stagingRef: `staging/jobs/${jobId}/${attemptId}`,
    toolName,
    occurredAt
  };
}

async function waitForStatus(jobId: string, status: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if ((await runtime?.get(jobId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Job did not reach ${status}.`);
}
