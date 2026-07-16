import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import { configurationBaselineContentHash, configurationBaselineDependencyHash } from "../runtime/storage/v2/engineeringBaselineIntegrity.js";
import type { StorageEngineeringPromotionDraft } from "../runtime/storage/v2/engineeringBaselineTypes.js";
import type { StorageCapabilityAudit } from "../runtime/storage/v2/types.js";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import { TerminalCasStore } from "../runtime/storage/v2/terminalCasStore.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";
import { DurableJobRuntimeTestSupport } from "./durableJobRuntimeTestSupport.js";
import { engineeringPromotionDraftKey } from "./durableEngineeringPromotionDrafts.js";
import { DurableToolExecutionAdapter } from "./durableToolExecutionAdapter.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;
const support = new DurableJobRuntimeTestSupport(
  () => runtime,
  () => root
);

afterEach(async () => {
  await runtime?.close().catch(() => undefined);
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("DurableToolExecutionAdapter", () => {
  it("fences tool lifecycle and promotes completed outputs atomically with job completion", async () => {
    const databasePath = createDatabase();
    let clockMs = Date.now();
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, clock: { now: () => clockMs }, dataRoot: root });
    const now = new Date(clockMs).toISOString();
    const completedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const promotedAt = new Date(Date.parse(now) + 2_000).toISOString();
    const baseline = configurationBaseline("project-1", now);
    let observedUnpromoted = false;
    runtime.registerHandler("research_loop", async (job) => {
      const adapter = new DurableToolExecutionAdapter(job, runtime as DurableJobRuntime);
      const artifact = action(job.id, now, "execution-1:action-1", "intent-1", 0, "DataAnalysisTool", "analysis");
      await adapter.onStatus({ ...artifact, status: "queued" });
      await adapter.onStatus({ ...artifact, status: "running" });
      await adapter.onStatus({
        ...artifact,
        status: "completed",
        occurredAt: completedAt,
        outputHash: "b".repeat(64),
        outputBytes: 128,
        outputIds: ["tool-run-1", "source-1", "artifact-1"],
        outputs: [
          { id: "source-1", kind: "source" },
          { id: "artifact-1", kind: "artifact", name: "Report", artifactKind: "generated_artifact" }
        ]
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

      const codex = {
        ...action(job.id, now, "execution-1:action-3", "intent-3", 2, "CodexCliTool", "exclusive"),
        inputs: { task: "Write one deterministic output.", inputArtifactIds: [], outputs: [{ relativePath: "result.txt", kind: "data" }] }
      };
      await adapter.onStatus({ ...codex, status: "queued" });
      await adapter.onStatus({ ...codex, status: "running" });
      const codexOutput = Buffer.from("verified output\n", "utf8");
      const outputManifestHash = prepareCodexWorkspace(codex, codexOutput, "artifact-codex", "c".repeat(64));
      await adapter.onStatus({
        ...codex,
        status: "completed",
        outputHash: "c".repeat(64),
        outputBytes: codexOutput.byteLength,
        outputs: [{ id: "artifact-codex", kind: "artifact", name: "Codex result", artifactKind: "generated_artifact" }],
        codexCliTrace: {
          cliVersion: "0.144.1",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandboxProfile: "aetherops-codex-workspace-v1",
          networkPolicy: "disabled",
          durationMs: 10,
          exitCode: 0,
          eventCount: 3,
          workspaceManifestHash: "a".repeat(64),
          outputManifestHash,
          terminationReason: "completed"
        }
      });
      clockMs = Date.parse(promotedAt);
      const codexCas = new TerminalCasStore(root as string).materializeBytes(codexOutput);
      const codexDraft = engineeringReportDraft(baseline, codexCas);
      await runtime?.finish(
        job.id,
        await support.currentRevision(job.projectId),
        adapter.completedOutputPromotions(
          promotedAt,
          new Map([[engineeringPromotionDraftKey("execution-1:action-3", "artifact", "artifact-codex"), codexDraft]])
        )
      );
    });
    await runtime.initialize();
    const projectRoot = join(root as string, "project-1");
    mkdirSync(projectRoot, { recursive: true });
    await runtime.syncProject({
      id: "project-1",
      projectRoot,
      topic: "Durable adapter",
      status: "active",
      autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
      createdAt: now,
      updatedAt: now
    });
    await runtime.engineering.activateBaseline(
      { baseline, expectedRevision: 0, changeReason: "Bind the Codex test output to an immutable baseline." },
      { projectRevision: 0, snapshotVersion: 0, capabilityAudits: baselineCapabilityAudits("project-1", 0) }
    );
    const receipt = await runtime.enqueue({
      projectId: "project-1",
      kind: "research_loop",
      projectRevision: await support.currentRevision("project-1"),
      idempotencyKey: "key-1",
      requestHash: "request-hash",
      payload: {}
    });
    await waitForStatus(receipt.jobId, "completed");

    expect(observedUnpromoted).toBe(true);
    const events = await runtime.eventsAfter("project-1");
    expect(events.filter((event) => event.type === "tool.run.changed")).toHaveLength(9);
    expect(events.filter((event) => event.type === "artifact.created")).toMatchObject([
      { data: { jobId: receipt.jobId, artifactId: "artifact-1", name: "Report", kind: "generated_artifact" } },
      { data: { jobId: receipt.jobId, artifactId: "artifact-codex", name: "Codex result", kind: "generated_artifact" } }
    ]);
    const detail = await runtime.getDetail(receipt.jobId);
    expect(detail?.trace.outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputId: "source-1", outputKind: "source", promoted: false, createdAt: completedAt }),
        expect.objectContaining({ outputId: "artifact-1", promoted: true, createdAt: completedAt, promotedAt })
      ])
    );
    expect(detail?.trace.toolDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: "WebFetchTool", policyStatus: "rejected" })]));
    expect(detail?.trace.codexCliExecutions).toMatchObject([
      { model: "gpt-5.6-sol", reasoningEffort: "high", networkPolicy: "disabled", outputManifestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }
    ]);
    expect(detail?.trace.toolAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ descriptorVersion: "1", descriptorSideEffects: [], idempotencyKey: expect.any(String) }),
        expect.objectContaining({ descriptorVersion: "1", descriptorSideEffects: ["network"], sideEffectKey: undefined }),
        expect.objectContaining({
          descriptorVersion: "1",
          descriptorSideEffects: ["filesystem", "process"],
          sideEffectKey: expect.any(String),
          postconditionReceipt: expect.objectContaining({ verifier: "storage-worker-codex-workspace-v1" })
        })
      ])
    );
  });

  it("does not promote a completed filesystem output without a trusted postcondition receipt", async () => {
    const databasePath = createDatabase();
    let blocked = false;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, dataRoot: root });
    runtime.registerHandler("research_loop", async (job) => {
      const adapter = new DurableToolExecutionAdapter(job, runtime as DurableJobRuntime);
      const event = action(job.id, "2026-07-14T00:00:00.000Z", "execution-2:action-1", "intent-1", 0, "ArtifactWriterTool", "artifact");
      await adapter.onStatus({ ...event, status: "queued" });
      await adapter.onStatus({ ...event, status: "running" });
      try {
        await adapter.onStatus({
          ...event,
          status: "completed",
          occurredAt: "2026-07-14T00:00:01.000Z",
          outputHash: "d".repeat(64),
          outputBytes: 128,
          outputs: [{ id: "artifact-ambiguous", kind: "artifact", name: "Ambiguous", artifactKind: "generated_artifact" }]
        });
      } catch (error) {
        blocked = /workspace|ENOENT/i.test(error instanceof Error ? error.message : String(error));
      }
      await runtime?.settle(job.id, "failed", await support.currentRevision(job.projectId), "ambiguous_side_effect_postcondition");
    });
    await runtime.initialize();
    const receipt = await support.enqueueCurrent({
      projectId: "project-1",
      kind: "research_loop",
      idempotencyKey: "key-ambiguous",
      requestHash: "request-hash-ambiguous",
      payload: {}
    });
    await waitForStatus(receipt.jobId, "failed");
    expect(blocked).toBe(true);
    const detail = await runtime.getDetail(receipt.jobId);
    expect(detail?.trace.outputs).toEqual([expect.objectContaining({ outputId: "artifact-ambiguous", promoted: false })]);
    expect((await runtime.eventsAfter("project-1")).filter((event) => event.type === "artifact.created")).toHaveLength(0);
  });

  it("persists a provisional completion as quarantined and leaves no dangling or promoted output after a downstream failure", async () => {
    const databasePath = createDatabase();
    let promotionCount = -1;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, dataRoot: root });
    runtime.registerHandler("research_loop", async (job) => {
      const adapter = new DurableToolExecutionAdapter(job, runtime as DurableJobRuntime);
      const first = action(job.id, "2026-07-14T00:00:00.000Z", "execution-3:action-1", "intent-1", 0, "WebFetchTool", "acquisition.fetch");
      const failed = action(job.id, "2026-07-14T00:00:00.000Z", "execution-3:action-2", "intent-2", 1, "DataAnalysisTool", "analysis");
      const pending = action(job.id, "2026-07-14T00:00:00.000Z", "execution-3:action-3", "intent-3", 2, "ArtifactWriterTool", "artifact");

      await adapter.onStatus({ ...first, status: "queued" });
      await adapter.onStatus({ ...failed, status: "queued" });
      await adapter.onStatus({ ...pending, status: "queued" });
      await adapter.onStatus({ ...first, status: "running", occurredAt: "2026-07-14T00:00:01.000Z" });
      await adapter.onStatus({
        ...first,
        status: "completed",
        occurredAt: "2026-07-14T00:00:02.000Z",
        outputHash: "e".repeat(64),
        outputBytes: 32,
        outputs: [{ id: "artifact-provisional", kind: "artifact", name: "Provisional", artifactKind: "generated_artifact" }]
      });
      await adapter.onStatus({ ...failed, status: "running", occurredAt: "2026-07-14T00:00:01.000Z" });
      await adapter.onStatus({
        ...failed,
        status: "failed",
        occurredAt: "2026-07-14T00:00:03.000Z",
        error: "stderr=RAW_TOOL_OUTPUT_CANARY",
        terminalCause: "tool_exception"
      });
      await adapter.onStatus({
        ...first,
        status: "quarantined",
        occurredAt: "2026-07-14T00:00:04.000Z",
        outputHash: "e".repeat(64),
        outputBytes: 32,
        outputs: [{ id: "artifact-provisional", kind: "artifact", name: "Provisional", artifactKind: "generated_artifact" }],
        quarantineRef: join(root as string, "quarantine", "jobs", job.id, "execution-3"),
        error: "stderr=RAW_TOOL_OUTPUT_CANARY",
        terminalCause: "UPSTREAM_FAILURE"
      });
      await adapter.onStatus({
        ...pending,
        status: "blocked",
        occurredAt: "2026-07-14T00:00:04.000Z",
        error: "A required upstream action failed.",
        terminalCause: "DEPENDENCY_FAILED"
      });

      promotionCount = adapter.completedOutputPromotions("2026-07-14T00:00:05.000Z").length;
      await runtime?.settle(job.id, "failed", await support.currentRevision(job.projectId), "analysis failed");
    });
    await runtime.initialize();
    const receipt = await support.enqueueCurrent({
      projectId: "project-1",
      kind: "research_loop",
      idempotencyKey: "key-partial-dag",
      requestHash: "request-hash-partial-dag",
      payload: {}
    });
    await waitForStatus(receipt.jobId, "failed");

    expect(promotionCount).toBe(0);
    const detail = await runtime.getDetail(receipt.jobId);
    expect(detail?.trace.toolAttempts.map(({ ordinal, status }) => ({ ordinal, status })).sort((left, right) => left.ordinal - right.ordinal)).toEqual([
      { ordinal: 0, status: "quarantined" },
      { ordinal: 1, status: "failed" },
      { ordinal: 2, status: "blocked" }
    ]);
    expect(detail?.trace.toolAttempts.some((attempt) => ["queued", "running"].includes(attempt.status))).toBe(false);
    expect(detail?.trace.toolAttempts.find((attempt) => attempt.ordinal === 1)?.error).toBe("TOOL_EXECUTION_FAILED");
    expect(JSON.stringify(detail?.trace)).not.toContain("RAW_TOOL_OUTPUT_CANARY");
    expect(detail?.trace.outputs).toEqual([expect.objectContaining({ outputId: "artifact-provisional", promoted: false })]);
    expect((await runtime.eventsAfter("project-1")).filter((event) => event.type === "artifact.created")).toHaveLength(0);
  });

  it("preserves a verified Codex postcondition receipt and accounting while quarantining its provisional output", async () => {
    const databasePath = createDatabase();
    let promotionCount = -1;
    runtime = new DurableJobRuntime(databasePath, { concurrency: 1, dataRoot: root });
    runtime.registerHandler("research_loop", async (job) => {
      const adapter = new DurableToolExecutionAdapter(job, runtime as DurableJobRuntime);
      const codex = {
        ...action(job.id, "2026-07-14T00:00:00.000Z", "execution-4:action-1", "intent-1", 0, "CodexCliTool", "exclusive"),
        inputs: { task: "Write one deterministic output.", inputArtifactIds: [], outputs: [{ relativePath: "result.txt", kind: "data" as const }] }
      };
      const failed = action(job.id, "2026-07-14T00:00:00.000Z", "execution-4:action-2", "intent-2", 1, "DataAnalysisTool", "analysis");
      const pending = action(job.id, "2026-07-14T00:00:00.000Z", "execution-4:action-3", "intent-3", 2, "ArtifactWriterTool", "artifact");
      const content = Buffer.from("verified provisional output\n", "utf8");

      await adapter.onStatus({ ...codex, status: "queued" });
      await adapter.onStatus({ ...failed, status: "queued" });
      await adapter.onStatus({ ...pending, status: "queued" });
      await adapter.onStatus({ ...codex, status: "running", occurredAt: "2026-07-14T00:00:01.000Z" });
      const outputManifestHash = prepareCodexWorkspace(codex, content, "artifact-codex-provisional", "f".repeat(64));
      const codexCompletion = {
        ...codex,
        status: "completed" as const,
        occurredAt: "2026-07-14T00:00:02.000Z",
        outputHash: "f".repeat(64),
        outputBytes: content.byteLength,
        outputs: [{ id: "artifact-codex-provisional", kind: "artifact" as const, name: "Codex provisional", artifactKind: "generated_artifact" }],
        codexCliTrace: {
          cliVersion: "0.144.1",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          sandboxProfile: "aetherops-codex-workspace-v1",
          networkPolicy: "disabled" as const,
          durationMs: 10,
          exitCode: 0,
          eventCount: 3,
          workspaceManifestHash: "a".repeat(64),
          outputManifestHash,
          terminationReason: "completed"
        }
      };
      await adapter.onStatus(codexCompletion);
      await adapter.onStatus({ ...failed, status: "running", occurredAt: "2026-07-14T00:00:01.000Z" });
      await adapter.onStatus({
        ...failed,
        status: "failed",
        occurredAt: "2026-07-14T00:00:03.000Z",
        error: "analysis failed",
        terminalCause: "tool_exception"
      });
      await adapter.onStatus({
        ...codexCompletion,
        status: "quarantined",
        occurredAt: "2026-07-14T00:00:04.000Z",
        quarantineRef: join(root as string, "quarantine", "jobs", job.id, "execution-4"),
        error: "analysis failed",
        terminalCause: "UPSTREAM_FAILURE"
      });
      await adapter.onStatus({
        ...pending,
        status: "blocked",
        occurredAt: "2026-07-14T00:00:04.000Z",
        error: "A required upstream action failed.",
        terminalCause: "DEPENDENCY_FAILED"
      });

      promotionCount = adapter.completedOutputPromotions("2026-07-14T00:00:05.000Z").length;
      await runtime?.settle(job.id, "failed", await support.currentRevision(job.projectId), "analysis failed");
    });
    await runtime.initialize();
    const receipt = await support.enqueueCurrent({
      projectId: "project-1",
      kind: "research_loop",
      idempotencyKey: "key-codex-quarantine",
      requestHash: "request-hash-codex-quarantine",
      payload: {}
    });
    await waitForStatus(receipt.jobId, "failed");

    expect(promotionCount).toBe(0);
    const detail = await runtime.getDetail(receipt.jobId);
    const codexAttempt = detail?.trace.toolAttempts.find((attempt) => attempt.ordinal === 0);
    expect(codexAttempt).toMatchObject({
      status: "quarantined",
      postconditionDisposition: "applied",
      postconditionReceipt: { verifier: "storage-worker-codex-workspace-v1" },
      data: { accounting: { workspaceOutputBytes: Buffer.byteLength("verified provisional output\n"), workspaceSource: "verified_codex_output_manifest_v1" } }
    });
    expect(detail?.trace.toolAttempts.some((attempt) => ["queued", "running"].includes(attempt.status))).toBe(false);
    expect(detail?.trace.outputs).toEqual([expect.objectContaining({ outputId: "artifact-codex-provisional", promoted: false })]);
    expect((await runtime.eventsAfter("project-1")).filter((event) => event.type === "artifact.created")).toHaveLength(0);
  });
});

function baselineCapabilityAudits(projectId: string, projectRevision: number): StorageCapabilityAudit[] {
  return (["agent", "engineering", "search"] as const).map((capability) => ({
    id: `baseline-${capability}-${projectRevision}`,
    projectId,
    operation: capability,
    capability,
    appAllowed: true,
    projectAllowed: capability !== "search",
    operationAllowed: capability !== "search",
    allowed: capability !== "search",
    data: { jobKind: "engineering_run", ...(capability === "search" ? { blockedBy: "project" as const } : {}), projectRevision },
    auditedAt: "2026-07-16T00:00:00.000Z"
  }));
}

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-tool-trace-"));
  const databasePath = join(root, "storage.sqlite");
  const db = new DatabaseSync(databasePath);
  migrateStorageV2Schema(db);
  db.close();
  return databasePath;
}

function action(jobId: string, occurredAt: string, attemptId: string, decisionId: string, ordinal: number, toolName: string, phase: string) {
  const [executionId, actionId] = attemptId.split(":");
  return {
    signal: new AbortController().signal,
    jobId,
    attemptId,
    decisionId,
    ordinal,
    phase: phase as "artifact",
    inputs: {},
    stagingRef: join(root as string, "staging", "jobs", jobId, executionId as string, "actions", actionId as string),
    toolName,
    occurredAt
  };
}

function prepareCodexWorkspace(
  event: ReturnType<typeof action> & { inputs: { outputs: Array<{ relativePath: string; kind: "data" }> } },
  content: Buffer,
  artifactId: string,
  outputHash: string
): string {
  const output = event.inputs.outputs[0]!;
  const outputsRoot = join(event.stagingRef, "workspace", "outputs");
  mkdirSync(outputsRoot, { recursive: true });
  writeFileSync(join(outputsRoot, output.relativePath), content);
  const status = {
    attemptId: event.attemptId,
    decisionId: event.decisionId,
    ordinal: event.ordinal,
    phase: event.phase,
    toolName: event.toolName,
    status: "completed",
    occurredAt: event.occurredAt,
    inputHash: hashCanonical(event.inputs),
    outputHash,
    outputBytes: content.byteLength,
    outputIds: ["tool-run-codex", artifactId]
  };
  writeFileSync(join(event.stagingRef, "status.json"), `${JSON.stringify(status)}\n`, "utf8");
  return hashCanonical([
    { relativePath: output.relativePath, kind: output.kind, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength }
  ]);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function configurationBaseline(projectId: string, createdAt: string): ConfigurationBaseline {
  const unhashed: ConfigurationBaseline = {
    id: "baseline-codex-adapter-v1",
    projectId,
    revision: 1,
    status: "active",
    unitConventionId: "si-v1",
    coordinateConventionId: "right-handed-cartesian-v1",
    solverVersions: { codex: "gpt-5.6-sol" },
    materialRevisionIds: [],
    sourceRevisionIds: ["fixture:durable-codex-adapter"],
    equationVersionIds: [],
    contentHash: "0".repeat(64),
    createdAt,
    createdBy: "durable-tool-execution-adapter-test",
    provenance: [{ id: "fixture:durable-codex-adapter", contentHash: hashCanonical("verified output\n") }]
  };
  return { ...unhashed, contentHash: configurationBaselineContentHash(unhashed) };
}

function engineeringReportDraft(baseline: ConfigurationBaseline, artifact: ReturnType<TerminalCasStore["materializeBytes"]>): StorageEngineeringPromotionDraft {
  const dependencyAspects = ["solver", "source_revision", "unit_convention", "coordinate_convention"] as const;
  return {
    resultKind: "engineering_report",
    baselineId: baseline.id,
    baselineRevision: baseline.revision,
    baselineContentHash: baseline.contentHash,
    baselineDependencyHash: configurationBaselineDependencyHash(baseline, dependencyAspects),
    dependencyAspects,
    artifact: { casLocator: artifact.casLocator, sha256: artifact.casHash, byteLength: artifact.byteLength, mediaType: "text/plain" },
    executionMedia: "codex@gpt-5.6-sol",
    modelCardId: "model-card:codex:gpt-5.6-sol",
    simulationRunReceiptId: "tool-run:codex-adapter",
    convergence: "not_applicable",
    domainAssessment: "not_assessed",
    sensitivity: "project"
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function waitForStatus(jobId: string, status: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if ((await runtime?.get(jobId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const observed = await runtime?.get(jobId);
  throw new Error(
    `Job did not reach ${status}; observed ${observed?.status ?? "missing"}: ${observed?.failureReason ?? observed?.blockedReason ?? "no reason"}.`
  );
}
