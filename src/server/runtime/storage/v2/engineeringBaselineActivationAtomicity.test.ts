import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigurationBaseline } from "../../../../core/aerospace/configurationBaseline.js";
import type { StorageCapabilityAudit } from "./types.js";
import { StorageWorkerRuntime } from "../worker/typedRuntime.js";
import { configurationBaselineContentHash } from "./engineeringBaselineIntegrity.js";
import { jobAtomicId } from "./jobAtomicIds.js";
import { migrateStorageV2Schema } from "./schema.js";
import { StorageImmutableConflictError, StorageRevisionConflictError } from "./runStateErrors.js";

let root: string | undefined;
let runtime: StorageWorkerRuntime | undefined;

afterEach(() => {
  runtime?.close();
  runtime = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("engineering baseline activation atomicity", () => {
  it("rolls baseline activation back when its snapshot event cannot commit and replays exactly after repair", () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-baseline-event-"));
    const path = join(root, "storage.sqlite");
    const setup = new DatabaseSync(path);
    migrateStorageV2Schema(setup);
    setup.exec(`
      create trigger fail_baseline_snapshot_event before insert on job_events
      when new.type='project.snapshot.changed'
      begin select raise(abort, 'injected baseline snapshot failure'); end;
    `);
    setup.close();
    runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    const baseline = activeBaseline();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    runtime.handle({
      name: "project.upsert",
      project: {
        id: baseline.projectId,
        projectRoot,
        topic: "Baseline event atomicity",
        status: "active",
        autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
        createdAt: baseline.createdAt,
        updatedAt: baseline.createdAt
      }
    });
    const command = {
      name: "engineering.baseline.activate" as const,
      input: { baseline, expectedRevision: 0, changeReason: "Initial verified configuration." },
      expectedProjectRevision: 0,
      capabilityAudits: capabilityAudits(baseline.projectId, 0),
      event: activationEvent(baseline, 0)
    };

    expect(() => runtime?.handle(command)).toThrow("injected baseline snapshot failure");
    const failedReadback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(failedReadback.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({ count: 0 });
      expect(failedReadback.prepare("select count(*) count from engineering_active_baselines").get()).toEqual({ count: 0 });
      expect(failedReadback.prepare("select count(*) count from job_events").get()).toEqual({ count: 0 });
    } finally {
      failedReadback.close();
    }

    const repair = new DatabaseSync(path);
    repair.exec("drop trigger fail_baseline_snapshot_event;");
    repair.close();
    const first = runtime?.handle(command) as { activation: { exactReplay: boolean }; event?: { type: string } };
    const replayBaseline = { ...baseline, id: "baseline-api-retry-uuid", createdAt: "2026-07-16T00:00:01.000Z" };
    const replay = runtime?.handle({
      ...command,
      input: { ...command.input, baseline: replayBaseline },
      event: activationEvent(replayBaseline, 0)
    }) as { activation: { exactReplay: boolean }; event?: { type: string } };
    const currentHeadReplay = runtime?.handle({
      ...command,
      input: { ...command.input, baseline: { ...replayBaseline, id: "baseline-current-head-retry" } },
      expectedProjectRevision: 1,
      capabilityAudits: capabilityAudits(baseline.projectId, 1),
      event: activationEvent(replayBaseline, 1)
    }) as { activation: { exactReplay: boolean }; event?: { type: string } };

    expect(first).toMatchObject({ activation: { exactReplay: false }, event: { type: "project.snapshot.changed" }, publishEvent: true });
    expect(replay).toMatchObject({ activation: { exactReplay: true }, event: { eventId: command.event.eventId, sequence: 1 }, publishEvent: true });
    expect(currentHeadReplay).toMatchObject({
      activation: { exactReplay: true },
      event: { eventId: command.event.eventId, sequence: 1 },
      publishEvent: false
    });
    expect(() =>
      runtime?.handle({
        ...command,
        input: {
          ...command.input,
          expectedRevision: 1,
          baseline: { ...replayBaseline, id: "baseline-mixed-replay-mode", revision: 2 }
        }
      })
    ).toThrow(StorageImmutableConflictError);
    expect(() =>
      runtime?.handle({
        ...command,
        input: { ...command.input, baseline: { ...replayBaseline, id: "baseline-invalid-revision-retry" } },
        expectedProjectRevision: 999,
        capabilityAudits: capabilityAudits(baseline.projectId, 999),
        event: activationEvent(replayBaseline, 999)
      })
    ).toThrow(StorageRevisionConflictError);
    expect(() =>
      runtime?.handle({
        ...command,
        input: {
          ...command.input,
          expectedRevision: 999,
          baseline: { ...replayBaseline, id: "baseline-forged-baseline-revision", revision: 1_000 }
        },
        expectedProjectRevision: 1,
        capabilityAudits: capabilityAudits(baseline.projectId, 1),
        event: activationEvent(replayBaseline, 1)
      })
    ).toThrow(StorageRevisionConflictError);
    expect(() =>
      runtime?.handle({
        ...command,
        input: { ...command.input, baseline: { ...replayBaseline, id: "baseline-denied-retry" } },
        expectedProjectRevision: 1,
        capabilityAudits: capabilityAudits(baseline.projectId, 1).map((audit) =>
          audit.capability === "engineering" ? { ...audit, appAllowed: false, allowed: false, data: { ...audit.data, blockedBy: "app" as const } } : audit
        ),
        event: activationEvent(replayBaseline, 1)
      })
    ).toThrow(StorageImmutableConflictError);
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({ count: 1 });
      expect(readback.prepare("select count(*) count from engineering_active_baselines").get()).toEqual({ count: 1 });
      expect(readback.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 3 });
      expect(readback.prepare("select allowed,data from capability_audits where capability='engineering'").get()).toEqual({
        allowed: 1,
        data: '{"jobKind":"engineering_run","projectRevision":0}'
      });
      expect(readback.prepare("select count(*) count from job_events").get()).toEqual({ count: 1 });
    } finally {
      readback.close();
    }
  });

  it("rejects a stale allowed audit when engineering is revoked before the activation commit", () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-baseline-capability-race-"));
    const path = join(root, "storage.sqlite");
    const setup = new DatabaseSync(path);
    migrateStorageV2Schema(setup);
    setup.close();
    runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    const baseline = activeBaseline();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    const project = {
      id: baseline.projectId,
      projectRoot,
      topic: "Capability race",
      status: "active",
      autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
      createdAt: baseline.createdAt,
      updatedAt: baseline.createdAt
    };
    runtime.handle({ name: "project.upsert", project });
    const staleCommand = {
      name: "engineering.baseline.activate" as const,
      input: { baseline, expectedRevision: 0, changeReason: "Captured before capability revocation." },
      expectedProjectRevision: 0,
      capabilityAudits: capabilityAudits(baseline.projectId, 0),
      event: activationEvent(baseline, 0)
    };

    runtime.handle({
      name: "project.upsert",
      project: {
        ...project,
        autonomyPolicy: { ...project.autonomyPolicy, allowCodeExecution: false },
        updatedAt: "2026-07-16T00:00:01.000Z"
      }
    });
    runtime.handle({
      name: "event.append",
      event: {
        eventId: "event-engineering-revoked",
        projectId: baseline.projectId,
        type: "project.snapshot.changed",
        createdAt: "2026-07-16T00:00:01.000Z",
        payload: { data: { reason: "project_updated" } }
      }
    });

    expect(() => runtime?.handle(staleCommand)).toThrow(StorageRevisionConflictError);
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 0 });
      expect(readback.prepare("select revision from project_revision_heads where project_id=?").get(baseline.projectId)).toEqual({ revision: 1 });
      expect(readback.prepare("select count(*) count from job_events where event_id=?").get(staleCommand.event.eventId)).toEqual({ count: 0 });
    } finally {
      readback.close();
    }
  });

  it("revalidates the allowed audit against the stored project inside the activation transaction", () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-baseline-capability-recheck-"));
    const path = join(root, "storage.sqlite");
    const setup = new DatabaseSync(path);
    migrateStorageV2Schema(setup);
    setup.close();
    runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    const baseline = activeBaseline();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    runtime.handle({
      name: "project.upsert",
      project: {
        id: baseline.projectId,
        projectRoot,
        topic: "Capability transaction recheck",
        status: "active",
        autonomyPolicy: { allowAgent: true, allowCodeExecution: false, allowExternalSearch: false },
        createdAt: baseline.createdAt,
        updatedAt: baseline.createdAt
      }
    });

    expect(() =>
      runtime?.handle({
        name: "engineering.baseline.activate",
        input: { baseline, expectedRevision: 0, changeReason: "Must not bypass current project policy." },
        expectedProjectRevision: 0,
        capabilityAudits: capabilityAudits(baseline.projectId, 0),
        event: activationEvent(baseline, 0)
      })
    ).toThrow(StorageImmutableConflictError);
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from job_events").get()).toEqual({ count: 0 });
    } finally {
      readback.close();
    }
  });

  it("rejects cross-project, wrong-type, wrong-id and job-bound activation events without partial writes", () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-baseline-event-identity-"));
    const path = join(root, "storage.sqlite");
    const setup = new DatabaseSync(path);
    migrateStorageV2Schema(setup);
    setup.close();
    runtime = new StorageWorkerRuntime({ appDbPath: path, vectorDbPath: path, ontologyDbPath: path });
    const baseline = activeBaseline();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    runtime.handle({
      name: "project.upsert",
      project: {
        id: baseline.projectId,
        projectRoot,
        topic: "Activation event identity",
        status: "active",
        autonomyPolicy: { allowAgent: true, allowCodeExecution: true, allowExternalSearch: false },
        createdAt: baseline.createdAt,
        updatedAt: baseline.createdAt
      }
    });
    const event = activationEvent(baseline, 0);
    const command = {
      name: "engineering.baseline.activate" as const,
      input: { baseline, expectedRevision: 0, changeReason: "Validate event ownership." },
      expectedProjectRevision: 0,
      capabilityAudits: capabilityAudits(baseline.projectId, 0),
      event
    };
    const invalidEvents = [
      { ...event, projectId: "project-foreign" },
      { ...event, type: "run.status.changed" },
      { ...event, eventId: "event-forged" },
      { ...event, jobId: "job-foreign" },
      { ...event, payload: { ...event.payload, projectRevision: 1 } }
    ];

    for (const invalidEvent of invalidEvents) {
      expect(() => runtime?.handle({ ...command, event: invalidEvent })).toThrow(StorageImmutableConflictError);
    }
    const readback = new DatabaseSync(path, { readOnly: true });
    try {
      expect(readback.prepare("select count(*) count from engineering_configuration_baselines").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from engineering_active_baselines").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from capability_audits").get()).toEqual({ count: 0 });
      expect(readback.prepare("select count(*) count from job_events").get()).toEqual({ count: 0 });
    } finally {
      readback.close();
    }
  });
});

function activeBaseline(): ConfigurationBaseline {
  const unhashed: ConfigurationBaseline = {
    id: "baseline-1",
    projectId: "project-baseline-event",
    revision: 1,
    status: "active",
    unitConventionId: "si-v1",
    coordinateConventionId: "body-axis-v1",
    solverVersions: { codex: "0.144.1" },
    materialRevisionIds: [],
    sourceRevisionIds: ["source-1"],
    equationVersionIds: [],
    contentHash: "0".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "baseline-atomicity-test",
    provenance: [{ id: "source-1", contentHash: "a".repeat(64) }]
  };
  return { ...unhashed, contentHash: configurationBaselineContentHash(unhashed) };
}

function activationEvent(baseline: ConfigurationBaseline, expectedProjectRevision: number) {
  return {
    eventId: jobAtomicId("event", baseline.projectId, baseline.contentHash, "baseline-activated"),
    projectId: baseline.projectId,
    type: "project.snapshot.changed",
    createdAt: baseline.createdAt,
    payload: {
      projectRevision: expectedProjectRevision,
      data: { snapshotVersion: expectedProjectRevision, reason: "project_updated" }
    }
  };
}

function capabilityAudits(projectId: string, projectRevision: number): StorageCapabilityAudit[] {
  return (["agent", "engineering", "search"] as const).map((capability) => {
    const operationAllowed = capability !== "search";
    return {
      id: `audit-${capability}-${projectRevision}`,
      projectId,
      operation: capability,
      capability,
      appAllowed: true,
      projectAllowed: capability !== "search",
      operationAllowed,
      allowed: capability !== "search" && operationAllowed,
      data: {
        jobKind: "engineering_run",
        ...(capability === "search" ? { blockedBy: "project" as const } : {}),
        projectRevision
      },
      auditedAt: "2026-07-16T00:00:00.000Z"
    };
  });
}
