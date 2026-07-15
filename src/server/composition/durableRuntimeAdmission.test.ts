import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStorageV2Schema } from "../runtime/storage/v2/schema.js";
import { DurableJobRuntime } from "./durableJobRuntime.js";

let root: string | undefined;
let runtime: DurableJobRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable runtime admission", () => {
  it("closes enqueue and claim admission synchronously when draining begins", async () => {
    const databasePath = createDatabase();
    runtime = new DurableJobRuntime(databasePath, 1);
    runtime.registerHandler("chat_reply", async () => {
      throw new Error("A drained runtime must not claim a newly submitted job.");
    });
    await runtime.initialize();

    runtime.beginDrain();
    await expect(
      runtime.enqueue({ projectId: "project-draining", kind: "chat_reply", projectRevision: 1, idempotencyKey: "draining", payload: {} })
    ).rejects.toMatchObject({ name: "DurableRuntimeAdmissionError", state: "draining" });

    const verify = new DatabaseSync(databasePath, { readOnly: true });
    expect(verify.prepare("select count(*) as count from jobs").get()).toEqual({ count: 0 });
    verify.close();
  });
});

function createDatabase(): string {
  root = mkdtempSync(join(tmpdir(), "aetherops-runtime-admission-"));
  const databasePath = join(root, "storage.sqlite");
  const database = new DatabaseSync(databasePath);
  migrateStorageV2Schema(database);
  database.close();
  return databasePath;
}
