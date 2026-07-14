import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { DurableJobRuntime } from "../../../src/server/composition/durableJobRuntime.js";
import { migrateStorageV2Schema } from "../../../src/server/runtime/storage/v2/schema.js";
import type { ReceiptCollector } from "./receiptRuntime.js";

export async function runDurableRestartProbe(runtimeRoot: string, receipts: ReceiptCollector): Promise<void> {
  const databaseFile = join(runtimeRoot, "durable-restart.sqlite");
  const database = new DatabaseSync(databaseFile);
  migrateStorageV2Schema(database);
  database.close();

  let executions = 0;
  const first = new DurableJobRuntime(databaseFile, 1);
  first.registerHandler("chat_reply", async (job) => {
    executions += 1;
    await first.finish(job.id, 1);
  });
  await first.initialize();
  const input = {
    projectId: "baseline-durable-project",
    kind: "chat_reply" as const,
    projectRevision: 1,
    idempotencyKey: "baseline-durable-idempotency",
    payload: { fixtureHandle: "durable-restart-v1" }
  };
  const accepted = await first.enqueue(input);
  const before = await waitForTerminal(first, accepted.jobId);
  const replay = await first.enqueue(input);
  const idempotencyReused = replay.jobId === accepted.jobId;
  await first.close();

  const second = new DurableJobRuntime(databaseFile, 1);
  await second.initialize();
  const after = await second.get(accepted.jobId);
  await second.close();

  receipts.add("side_effect", {
    scenarioId: "durable-restart-probe",
    logicalCallId: "durable-restart-probe:effect:1",
    effectKey: "durable-idempotency-effect-v1",
    committed: executions === 1
  });
  receipts.add("durable_restart_readback", {
    scenarioId: "durable-restart-probe",
    storageKind: "sqlite-worker",
    beforeStatus: before.status,
    afterStatus: after?.status ?? "missing",
    projectRevision: after?.projectRevision ?? null,
    exactTerminalReadbackMatched: before.status === "completed" && after?.status === before.status,
    idempotencyReused,
    handlerExecutions: executions
  });
}

async function waitForTerminal(runtime: DurableJobRuntime, jobId: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const job = await runtime.get(jobId);
    if (job && ["paused", "aborted", "blocked", "failed", "completed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Durable baseline probe did not reach a terminal state.");
}
