import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStorageWorkerClient, type StorageWorkerClient } from "../worker/typedRuntime.js";
import type { StorageFencedWriteCommand } from "../worker/typedProtocol.js";
import type { StorageToolPostconditionVerifyResult } from "./jobAtomicTypes.js";
import { migrateStorageV2Schema } from "./schema.js";
import { computeToolPostconditionReceiptHash } from "./toolPostcondition.js";
import type { StorageToolAttempt, StorageToolOutputLink } from "./traceTypes.js";
import type { StorageToolSideEffectReservation } from "./toolSideEffectReservationTypes.js";
import type { StorageJobEvent, StorageLeaseFence } from "./types.js";

const roots: string[] = [];
const clients: StorageWorkerClient[] = [];
let fixtureSequence = 0;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage-worker tool postcondition authority boundary", () => {
  it("reads back a valid Codex workspace, issues one receipt, and makes exact replay idempotent", async () => {
    const harness = await createHarness({ codex: true });
    const outputManifestHash = writeCodexOutput(harness, "verified output\n");
    await saveCodexTrace(harness, outputManifestHash);
    writeStatus(harness);

    const first = await verify(harness);
    const second = await verify(harness);

    expect(first).toMatchObject({
      attempt: {
        id: harness.attempt.id,
        postconditionDisposition: "applied",
        postconditionReceipt: { verifier: "storage-worker-codex-workspace-v1" }
      },
      event: { type: "tool.run.changed" }
    });
    expect(second.event).toBeUndefined();
    expect(second.attempt.postconditionReceipt).toEqual(first.attempt.postconditionReceipt);
    await expect(
      harness.client.request<StorageToolSideEffectReservation | undefined>({ name: "trace.sideEffect.getAttempt", attemptId: harness.attempt.id })
    ).resolves.toMatchObject({ status: "applied", generation: 1, attemptId: harness.attempt.id });
    await expect(
      fenced(harness, [
        {
          name: "trace.attempt.save",
          attempt: {
            ...first.attempt,
            postconditionReceipt: { ...first.attempt.postconditionReceipt!, evidenceHash: "f".repeat(64) }
          }
        }
      ])
    ).rejects.toThrow(/only by the storage-worker verifier/i);

    const events = await harness.client.request<StorageJobEvent[]>({
      name: "event.after",
      projectId: harness.projectId,
      lastEventId: 0
    });
    expect(events.filter((event) => event.eventId === first.event?.eventId)).toHaveLength(1);
  });

  it("rejects a caller-supplied receipt through generic trace.attempt.save", async () => {
    const harness = await createHarness();
    writeStatus(harness);
    const receipt = callerReceipt(harness);

    await expect(
      fenced(harness, [
        {
          name: "trace.attempt.save",
          attempt: { ...harness.attempt, postconditionDisposition: "applied", postconditionReceipt: receipt }
        }
      ])
    ).rejects.toThrow(/only by the storage-worker verifier/i);

    await expect(harness.client.request({ name: "trace.attempt.get", attemptId: harness.attempt.id })).resolves.toMatchObject({
      id: harness.attempt.id,
      postconditionDisposition: undefined,
      postconditionReceipt: undefined
    });
  });

  it.each([
    { label: "workspace", prepare: () => undefined, error: /workspace is missing/i },
    { label: "status receipt", prepare: (harness: Harness) => mkdirSync(harness.actionRoot, { recursive: true }), error: /status receipt is missing/i }
  ])("fails explicitly when the $label is missing", async ({ prepare, error }) => {
    const harness = await createHarness();
    prepare(harness);
    await expect(verify(harness)).rejects.toThrow(error);
    await expectUnverified(harness);
  });

  it("rejects an action staging reference outside the fenced job root", async () => {
    const harness = await createHarness({
      stagingRef: (root) => join(root, "outside-fenced-job", "action")
    });
    mkdirSync(harness.actionRoot, { recursive: true });
    writeStatus(harness);

    await expect(verify(harness)).rejects.toThrow(/escapes the fenced job workspace/i);
    await expectUnverified(harness);
  });

  it("rejects a symbolic-link action workspace before reading its status", async () => {
    const harness = await createHarness();
    const external = join(harness.root, "external-action");
    mkdirSync(external, { recursive: true });
    mkdirSync(dirname(harness.actionRoot), { recursive: true });
    symlinkSync(external, harness.actionRoot, process.platform === "win32" ? "junction" : "dir");

    await expect(verify(harness)).rejects.toThrow(/symbolic link/i);
    await expectUnverified(harness);
  });

  it("rejects a symbolic-link Codex output root even when its file manifest hash matches", async () => {
    const harness = await createHarness({ codex: true });
    const external = join(harness.root, "external-codex-outputs");
    const bytes = Buffer.from("outside output\n", "utf8");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "result.json"), bytes);
    mkdirSync(join(harness.actionRoot, "workspace"), { recursive: true });
    symlinkSync(external, join(harness.actionRoot, "workspace", "outputs"), process.platform === "win32" ? "junction" : "dir");
    await saveCodexTrace(harness, hashCanonical([{ relativePath: "result.json", kind: "data", sha256: hashBytes(bytes), bytes: bytes.byteLength }]));
    writeStatus(harness);

    await expect(verify(harness)).rejects.toThrow(/symbolic link/i);
    await expectUnverified(harness);
  });

  it("rejects a status receipt whose immutable output hash was changed", async () => {
    const harness = await createHarness();
    writeStatus(harness, { outputHash: hashText("tampered status output") });

    await expect(verify(harness)).rejects.toThrow(/does not match its immutable attempt trace/i);
    await expectUnverified(harness);
  });

  it("rejects duplicate persisted output identities", async () => {
    const harness = await createHarness();
    await fenced(harness, [
      {
        name: "trace.output.record",
        link: { ...harness.link, id: `${harness.link.id}-duplicate`, outputKind: "evidence" }
      }
    ]);
    writeStatus(harness);

    await expect(verify(harness)).rejects.toThrow(/outputs do not match/i);
    await expectUnverified(harness);
  });

  it("rejects a Codex output file modified after its immutable execution trace", async () => {
    const harness = await createHarness({ codex: true });
    const outputManifestHash = writeCodexOutput(harness, "original output\n");
    await saveCodexTrace(harness, outputManifestHash);
    writeStatus(harness);
    writeFileSync(join(harness.actionRoot, "workspace", "outputs", "result.json"), "modified output\n", "utf8");

    await expect(verify(harness)).rejects.toThrow(/output manifest changed after workspace validation/i);
    await expectUnverified(harness);
  });
});

interface Harness {
  root: string;
  client: StorageWorkerClient;
  projectId: string;
  jobId: string;
  executionId: string;
  actionId: string;
  rawAttemptId: string;
  actionRoot: string;
  fence: StorageLeaseFence;
  verifiedAt: string;
  attempt: StorageToolAttempt;
  link: StorageToolOutputLink;
  toolName: string;
}

interface HarnessOptions {
  codex?: boolean;
  stagingRef?: (root: string, jobId: string, executionId: string, actionId: string) => string;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const sequence = ++fixtureSequence;
  const root = mkdtempSync(join(tmpdir(), `aetherops-postcondition-${sequence}-`));
  roots.push(root);
  const databasePath = join(root, "storage.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    migrateStorageV2Schema(database, { requireFts5: true });
  } finally {
    database.close();
  }
  const client = createStorageWorkerClient({
    appDbPath: databasePath,
    vectorDbPath: databasePath,
    ontologyDbPath: databasePath,
    dataRoot: root,
    requireFts5: true
  });
  clients.push(client);

  const baseMs = Date.now();
  const projectId = `project-postcondition-${sequence}`;
  const jobId = `job-postcondition-${sequence}`;
  const executionId = `execution-${sequence}`;
  const actionId = `action-${sequence}`;
  const rawAttemptId = `${executionId}:${actionId}`;
  const decisionId = traceId("decision", jobId, executionId, actionId);
  const attemptId = traceId("attempt", jobId, rawAttemptId);
  const toolName = options.codex ? "CodexCliTool" : "ArtifactWriter";
  const createdAt = new Date(baseMs).toISOString();
  const completedAt = new Date(baseMs + 1_000).toISOString();
  const verifiedAt = new Date(baseMs + 2_000).toISOString();
  const actionRoot = options.stagingRef?.(root, jobId, executionId, actionId) ?? join(root, "staging", "jobs", jobId, executionId, "actions", actionId);
  const stagingRef = relative(root, actionRoot).split(sep).join("/");

  await client.request({
    name: "job.enqueue",
    capabilityAudits: capabilityAudits(projectId, jobId, createdAt),
    job: {
      id: jobId,
      projectId,
      operation: "research_loop",
      createdAt,
      queuedAt: createdAt,
      payload: { projectRevision: 1 },
      requestedCapabilities: { agent: true, engineering: true, search: false },
      effectiveCapabilities: { agent: true, engineering: true, search: false },
      toolPolicy: { allowCodexCli: options.codex === true, sourceAccess: { mode: "offline" } }
    }
  });
  const claimed = await client.request<{ fence: StorageLeaseFence }>({
    name: "job.claimAndStart",
    options: {
      projectId,
      leaseOwner: `postcondition-worker-${sequence}`,
      now: createdAt,
      leaseExpiresAt: new Date(baseMs + 120_000).toISOString()
    }
  });
  const inputHash = hashText(`input-${sequence}`);
  const outputHash = hashText(`output-${sequence}`);
  const attempt: StorageToolAttempt = {
    id: attemptId,
    projectId,
    jobId,
    decisionId,
    ordinal: 0,
    status: "completed",
    inputHash,
    outputHash,
    traceVersion: 1,
    traceAvailability: "vnext",
    descriptorVersion: "1",
    descriptorSideEffects: options.codex ? ["filesystem", "process"] : ["filesystem"],
    sideEffectKey: hashText(`side-effect-${sequence}`),
    idempotencyKey: hashText(`idempotency-${sequence}`),
    dependsOnAttemptIds: [],
    stagingRef,
    queuedAt: createdAt,
    startedAt: createdAt,
    completedAt,
    data: { accounting: { version: 1, canonicalResultBytes: 64, source: "canonical_result_utf8_v1" } }
  };
  const link: StorageToolOutputLink = {
    id: traceId("output", attemptId, "artifact", `artifact-${sequence}`),
    projectId,
    jobId,
    attemptId,
    outputKind: "artifact",
    outputId: `artifact-${sequence}`,
    promoted: false,
    createdAt: completedAt
  };
  const commands: StorageFencedWriteCommand[] = [
    {
      name: "trace.decision.record",
      decision: {
        id: decisionId,
        projectId,
        jobId,
        toolName,
        purpose: "Verify a bounded action workspace.",
        expectedOutcome: "A hash-bound output receipt.",
        rawSelection: { inputHash },
        userPinned: options.codex === true,
        policyStatus: "accepted",
        compiledAction: {
          toolName,
          ordinal: 0,
          phase: "artifact",
          inputHash,
          ...(options.codex ? { outputDeclarations: [{ relativePath: "result.json", kind: "data" }] } : {})
        },
        createdAt
      }
    },
    {
      name: "trace.attempt.save",
      attempt: {
        ...attempt,
        status: "queued",
        outputHash: undefined,
        terminalCause: undefined,
        startedAt: undefined,
        completedAt: undefined
      }
    },
    {
      name: "trace.attempt.save",
      attempt: { ...attempt, status: "running", outputHash: undefined, terminalCause: undefined, completedAt: undefined }
    },
    { name: "trace.attempt.save", attempt },
    { name: "trace.output.record", link }
  ];
  await client.request({ name: "fencedTransaction", fence: claimed.fence, now: createdAt, commands });
  return { root, client, projectId, jobId, executionId, actionId, rawAttemptId, actionRoot, fence: claimed.fence, verifiedAt, attempt, link, toolName };
}

function capabilityAudits(projectId: string, jobId: string, auditedAt: string) {
  return (["agent", "engineering", "search"] as const).map((capability) => {
    const operationAllowed = capability !== "search";
    return {
      id: `capability-${jobId}-${capability}`,
      projectId,
      jobId,
      operation: capability,
      capability,
      appAllowed: true,
      projectAllowed: true,
      operationAllowed,
      allowed: operationAllowed,
      data: { jobKind: "research_loop" as const, ...(operationAllowed ? {} : { blockedBy: "job" as const }) },
      auditedAt
    };
  });
}

function writeStatus(harness: Harness, override: Record<string, unknown> = {}): void {
  mkdirSync(harness.actionRoot, { recursive: true });
  const status = {
    attemptId: harness.rawAttemptId,
    decisionId: harness.actionId,
    ordinal: 0,
    phase: "artifact",
    toolName: harness.toolName,
    status: "completed",
    occurredAt: harness.attempt.completedAt,
    inputHash: harness.attempt.inputHash,
    outputHash: harness.attempt.outputHash,
    outputBytes: 64,
    outputIds: [`tool-run-${harness.actionId}`, harness.link.outputId],
    ...override
  };
  writeFileSync(join(harness.actionRoot, "status.json"), `${JSON.stringify(status)}\n`, "utf8");
}

function writeCodexOutput(harness: Harness, content: string): string {
  const outputsRoot = join(harness.actionRoot, "workspace", "outputs");
  mkdirSync(outputsRoot, { recursive: true });
  const bytes = Buffer.from(content, "utf8");
  writeFileSync(join(outputsRoot, "result.json"), bytes);
  return hashCanonical([{ relativePath: "result.json", kind: "data", sha256: hashBytes(bytes), bytes: bytes.byteLength }]);
}

async function saveCodexTrace(harness: Harness, outputManifestHash: string): Promise<void> {
  await fenced(harness, [
    {
      name: "trace.codex.save",
      execution: {
        id: traceId("codex", harness.attempt.id),
        projectId: harness.projectId,
        jobId: harness.jobId,
        attemptId: harness.attempt.id,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sandboxProfile: "offline-staging-v1",
        networkPolicy: "disabled",
        durationMs: 10,
        exitCode: 0,
        terminationReason: "completed",
        eventCount: 1,
        workspaceManifestHash: hashText("workspace-manifest"),
        outputManifestHash,
        createdAt: harness.attempt.startedAt as string,
        completedAt: harness.attempt.completedAt
      }
    }
  ]);
}

function verify(harness: Harness): Promise<StorageToolPostconditionVerifyResult> {
  return harness.client.request({
    name: "toolPostcondition.verify",
    input: { fence: harness.fence, attemptId: harness.attempt.id, projectRevision: 1, verifiedAt: harness.verifiedAt }
  });
}

function fenced(harness: Harness, commands: StorageFencedWriteCommand[]): Promise<unknown> {
  return harness.client.request({ name: "fencedTransaction", fence: harness.fence, now: harness.attempt.completedAt, commands });
}

async function expectUnverified(harness: Harness): Promise<void> {
  await expect(harness.client.request({ name: "trace.attempt.get", attemptId: harness.attempt.id })).resolves.toMatchObject({
    id: harness.attempt.id,
    postconditionDisposition: undefined,
    postconditionReceipt: undefined
  });
}

function callerReceipt(harness: Harness) {
  const receipt = {
    receiptId: "caller-issued-receipt",
    evidenceHash: hashText("caller evidence"),
    verifier: "caller-controlled-verifier",
    verifiedAt: harness.verifiedAt
  };
  return {
    ...receipt,
    receiptHash: computeToolPostconditionReceiptHash({
      attemptId: harness.attempt.id,
      descriptorVersion: harness.attempt.descriptorVersion,
      idempotencyKey: harness.attempt.idempotencyKey as string,
      sideEffectKey: harness.attempt.sideEffectKey as string,
      disposition: "applied",
      ...receipt
    })
  };
}

function traceId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashCanonical(value: unknown): string {
  return hashText(canonicalJson(value));
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
