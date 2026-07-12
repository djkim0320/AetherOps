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
  it("commits tool lifecycle events and emits artifacts only after promotion", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-tool-trace-"));
    const databasePath = join(root, "storage.sqlite");
    const db = new DatabaseSync(databasePath);
    migrateStorageV2Schema(db);
    const now = new Date().toISOString();
    db.prepare(
      `insert into jobs (id, project_id, operation, status, priority, attempt, idempotency_key, request_hash,
       queued_at, created_at, updated_at, payload) values (?, ?, ?, 'running', 0, 1, ?, ?, ?, ?, ?, ?)`
    ).run("job-1", "project-1", "research_loop", "key-1", "request-hash", now, now, now, JSON.stringify({ projectRevision: 4 }));
    db.close();
    runtime = new DurableJobRuntime(databasePath, 1);
    const job = await runtime.get("job-1");
    if (!job) throw new Error("Seed job not found.");
    const adapter = new DurableToolExecutionAdapter(job, runtime);
    const base = {
      signal: new AbortController().signal,
      jobId: job.id,
      attemptId: "execution-1:action-1",
      decisionId: "intent-1",
      ordinal: 0,
      phase: "artifact" as const,
      inputs: { artifacts: [{ relativePath: "report.md", kind: "research_report", format: "markdown" }] },
      stagingRef: "staging/jobs/job-1/execution-1/actions/action-1",
      toolName: "ArtifactWriterTool"
    };
    await adapter.onStatus({ ...base, status: "queued", occurredAt: now });
    await adapter.onStatus({ ...base, status: "running", occurredAt: now });
    await adapter.onStatus({
      ...base,
      status: "completed",
      occurredAt: now,
      outputIds: ["tool-run-1", "artifact-1"],
      outputs: [{ id: "artifact-1", kind: "artifact", name: "Report", artifactKind: "generated_artifact" }]
    });

    expect((await runtime.eventsAfter("project-1")).filter((event) => event.type === "artifact.created")).toHaveLength(0);
    expect((await runtime.getDetail("job-1"))?.trace.outputs).toMatchObject([{ outputId: "artifact-1", promoted: false }]);

    await adapter.promoteCompletedOutputs(5);
    await adapter.promoteCompletedOutputs(5);
    const events = await runtime.eventsAfter("project-1");
    expect(events.filter((event) => event.type === "tool.run.changed")).toHaveLength(3);
    expect(events.filter((event) => event.type === "artifact.created")).toMatchObject([
      { data: { jobId: "job-1", artifactId: "artifact-1", name: "Report", kind: "generated_artifact" } }
    ]);
    expect((await runtime.getDetail("job-1"))?.trace.outputs).toMatchObject([{ outputId: "artifact-1", promoted: true }]);

    const denied = {
      ...base,
      attemptId: "execution-1:action-2",
      decisionId: "intent-2",
      ordinal: 1,
      phase: "acquisition.fetch" as const,
      toolName: "WebFetchTool",
      inputs: { urls: ["https://example.com/source"] }
    };
    await adapter.onStatus({ ...denied, status: "queued", occurredAt: now });
    await adapter.onStatus({
      ...denied,
      status: "blocked",
      policyStatus: "rejected",
      policyReason: "Search was revoked after enqueue.",
      error: "Search was revoked after enqueue.",
      occurredAt: now
    });
    const detail = await runtime.getDetail("job-1");
    expect(detail?.trace.toolDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "WebFetchTool", policyStatus: "rejected" })]));
    expect(detail?.trace.toolAttempts).toEqual(expect.arrayContaining([expect.objectContaining({ ordinal: 1, status: "blocked" })]));

    const codex = {
      ...base,
      attemptId: "execution-1:action-3",
      decisionId: "intent-3",
      ordinal: 2,
      phase: "exclusive" as const,
      toolName: "CodexCliTool",
      inputs: { task: "Write the declared report.", inputArtifactIds: [], outputs: [{ relativePath: "report.md", kind: "report" }] }
    };
    await adapter.onStatus({ ...codex, status: "queued", occurredAt: now });
    await adapter.onStatus({ ...codex, status: "running", occurredAt: now });
    await adapter.onStatus({
      ...codex,
      status: "completed",
      occurredAt: now,
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
    expect((await runtime.getDetail("job-1"))?.trace.codexCliExecutions).toMatchObject([
      {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        networkPolicy: "disabled",
        outputManifestHash: "b".repeat(64)
      }
    ]);
  });
});
