import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { storageCanonicalHasher } from "../v2/runStatePayloadValidator.js";
import { migrateStorageV2Schema } from "../v2/schema.js";
import type { StorageProjectMutationFinalizeResult, StorageProjectMutationPrepareResult } from "../v2/projectMutationTypes.js";
import { StorageWorkerRuntime } from "./typedRuntime.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project mutation storage worker protocol", () => {
  it("round-trips prepare, recovery lookup, legacy receipt, finalize, and pending list", () => {
    const root = mkdtempSync(join(tmpdir(), "aetherops-project-mutation-worker-"));
    roots.push(root);
    const path = join(root, "storage.sqlite");
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    const setup = new DatabaseSync(path);
    migrateStorageV2Schema(setup);
    setup.close();
    const runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    try {
      const prepared = runtime.handle({
        name: "projectMutation.prepare",
        input: {
          method: "projects.create",
          requestId: "worker-create",
          requestHash: "1".repeat(64),
          projectId: "project-worker",
          expectedProjectRevision: 0,
          command: { projectId: "project-worker" },
          legacyBeforeHash: "2".repeat(64),
          preparedAt: "2026-07-16T00:00:00.000Z"
        }
      }) as StorageProjectMutationPrepareResult;
      expect(runtime.handle({ name: "projectMutation.listPending", limit: 10 })).toMatchObject({
        mutations: [{ operationId: prepared.journal.operationId, state: "prepared" }]
      });
      expect(
        runtime.handle({ name: "projectMutation.lookup", method: "projects.create", requestId: "worker-create", requestHash: "1".repeat(64) })
      ).toMatchObject({ operationId: prepared.journal.operationId });
      runtime.handle({
        name: "projectMutation.markLegacyApplied",
        input: {
          operationId: prepared.journal.operationId,
          legacyReceiptHash: "3".repeat(64),
          snapshotHash: "4".repeat(64),
          appliedAt: "2026-07-16T00:00:01.000Z"
        }
      });
      const project = {
        id: "project-worker",
        projectRoot,
        topic: "Worker protocol",
        status: "active",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:02.000Z"
      };
      const publicResult = { projectId: project.id, projectRevision: 1 };
      const result = runtime.handle({
        name: "projectMutation.finalize",
        input: {
          operationId: prepared.journal.operationId,
          project,
          eventId: "worker-project-created",
          snapshotHash: "4".repeat(64),
          occurredAt: project.updatedAt,
          publicResult,
          publicResultHash: storageCanonicalHasher.sha256Canonical(publicResult)
        }
      }) as StorageProjectMutationFinalizeResult;
      expect(result).toMatchObject({ projectRevision: 1, exactReplay: false, journal: { state: "finalized" } });
      expect(runtime.handle({ name: "projectMutation.listPending" })).toEqual({ mutations: [] });
    } finally {
      runtime.close();
    }
  });
});
