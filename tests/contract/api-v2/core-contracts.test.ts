import { describe, expect, it } from "vitest";
import { API_V2_ERROR_CODES, RpcErrorSchema, RpcRequestV2Schema } from "../../../src/contracts/api-v2/common.js";
import { SseEventSchema, SSE_EVENT_NAMES_V2 } from "../../../src/contracts/api-v2/events.js";
import { JobReceiptSchema, JobRpcRequestSchema, JOB_STATUSES_V2 } from "../../../src/contracts/api-v2/jobs.js";
import { ProjectRpcRequestSchema } from "../../../src/contracts/api-v2/projects.js";
import { API_V2_METHODS, ApiV2RpcRequestSchema } from "../../../src/contracts/api-v2/rpc.js";
import * as apiV2 from "../../../src/contracts/api-v2/index.js";

const timestamp = "2026-07-10T10:00:00.000Z";

describe("API v2 common envelope", () => {
  it("publishes only the canonical v2 method surface", () => {
    expect(API_V2_METHODS).toEqual([
      "projects.create",
      "projects.update",
      "projects.get",
      "projects.list",
      "sessions.create",
      "sessions.delete",
      "chat.enqueue",
      "loop.start",
      "loop.pause",
      "loop.resume",
      "loop.abort",
      "jobs.get",
      "jobs.list",
      "engineering.enqueue",
      "engineering.preflight",
      "engineering.baseline.activate",
      "engineering.baseline.get",
      "engineering.baseline.list",
      "engineering.artifact.read",
      "snapshots.get",
      "settings.get",
      "settings.save",
      "tools.diagnostics",
      "auth.codexStatus",
      "llm.status"
    ]);
    expect(API_V2_METHODS).not.toContain("opencode.run");
    expect(ApiV2RpcRequestSchema.parse({ requestId: "r-list", method: "projects.list", params: {} }).method).toBe("projects.list");
  });

  it("validates strict engineering baseline and artifact read contracts", () => {
    const geometryHash = "a".repeat(64);
    const quantity = (value: number, length: number, unit: string) => ({
      kind: "scalar",
      valueSI: value,
      dimension: { mass: 0, length, time: 0, temperature: 0, current: 0, amount: 0, luminousIntensity: 0, angle: 0 },
      semantic: "generic",
      originalValue: value,
      originalUnit: unit,
      displayUnit: unit,
      provenance: { sourceType: "user", sourceId: "contract-test" },
      serializationVersion: 1
    });
    const activate = {
      requestId: "engineering-baseline-activate",
      method: "engineering.baseline.activate",
      params: {
        projectId: "project-1",
        expectedRevision: 0,
        changeReason: "Pin reference geometry before execution.",
        baseline: {
          geometryHash,
          aerodynamicReference: {
            area: quantity(1, 2, "m^2"),
            chord: quantity(1, 1, "m"),
            momentReferencePointId: "quarter-chord",
            axisConventionId: "wind-axes-v1",
            dynamicPressureDefinition: "q=0.5*rho*V^2"
          },
          unitConventionId: "si-v1",
          coordinateConventionId: "wind-axes-v1",
          solverVersions: { "xfoil-wasm": "0.1.1" },
          materialRevisionIds: [],
          sourceRevisionIds: ["fixture:naca0012"],
          equationVersionIds: ["aero-coefficients-v1"],
          createdBy: "contract-test",
          provenance: [{ id: "fixture:naca0012", contentHash: geometryHash }]
        }
      }
    } as const;
    expect(ApiV2RpcRequestSchema.parse(activate).method).toBe("engineering.baseline.activate");
    expect(
      ApiV2RpcRequestSchema.parse({
        requestId: "engineering-artifact-read",
        method: "engineering.artifact.read",
        params: { projectId: "project-1", promotionId: "promotion-1", maximumBytes: 65_536 }
      }).method
    ).toBe("engineering.artifact.read");
    expect(ApiV2RpcRequestSchema.safeParse({ ...activate, params: { ...activate.params, extra: true } }).success).toBe(false);
    expect(
      ApiV2RpcRequestSchema.safeParse({
        ...activate,
        params: {
          ...activate.params,
          baseline: { ...activate.params.baseline, sourceRevisionIds: ["fixture:naca0012", "fixture:naca0012"] }
        }
      }).success
    ).toBe(false);
    expect(
      ApiV2RpcRequestSchema.safeParse({
        ...activate,
        params: {
          ...activate.params,
          baseline: {
            ...activate.params.baseline,
            provenance: [
              { id: "fixture:naca0012", contentHash: geometryHash },
              { id: "fixture:naca0012", contentHash: "b".repeat(64) }
            ]
          }
        }
      }).success
    ).toBe(false);
    expect(
      ApiV2RpcRequestSchema.safeParse({
        requestId: "engineering-artifact-oversized",
        method: "engineering.artifact.read",
        params: { projectId: "project-1", promotionId: "promotion-1", maximumBytes: 65_537 }
      }).success
    ).toBe(false);
  });

  it("exposes one canonical receipt and execution-state schema from the public index", () => {
    expect(apiV2.JobReceiptSchema).toBe(JobReceiptSchema);
    expect(apiV2.ProjectExecutionStateSchema).toBeDefined();
    expect(
      apiV2.EngineeringJobReceiptSchema.safeParse({
        jobId: "j-engineering",
        projectId: "p1",
        kind: "research_loop",
        status: "queued",
        queuePosition: 0,
        acceptedAt: timestamp,
        projectRevision: 1
      }).success
    ).toBe(false);
  });
  it("accepts named params and rejects positional or legacy fields", () => {
    expect(RpcRequestV2Schema.parse({ requestId: "request-1", method: "projects.list", params: {} })).toEqual({
      requestId: "request-1",
      method: "projects.list",
      params: {}
    });
    expect(() => RpcRequestV2Schema.parse({ requestId: "request-1", method: "projects.list", params: {}, args: [] })).toThrow();
    expect(() => RpcRequestV2Schema.parse({ requestId: "request-1", method: "projects.list", args: [] })).toThrow();
    expect(() => RpcRequestV2Schema.parse({ requestId: "../../untrusted request id", method: "projects.list", params: {} })).toThrow();
  });

  it("allows only the exact public error codes", () => {
    for (const code of API_V2_ERROR_CODES) {
      expect(RpcErrorSchema.parse({ code, message: "error" }).code).toBe(code);
    }
    expect(API_V2_ERROR_CODES).toEqual([
      "VALIDATION_ERROR",
      "CONFLICT",
      "CAPABILITY_DENIED",
      "NOT_READY",
      "NOT_FOUND",
      "INTERRUPTED",
      "METHOD_NOT_FOUND",
      "INTERNAL_ERROR"
    ]);
    expect(() => RpcErrorSchema.parse({ code: "UNKNOWN", message: "error" })).toThrow();
  });
});

describe("project and session contracts", () => {
  it.each([
    ["projects.create", { input: { goal: "goal", topic: "topic", scope: "scope", budget: "budget" } }],
    ["projects.update", { projectId: "p1", expectedRevision: 3, input: { goal: "new goal" } }],
    ["projects.get", { projectId: "p1" }],
    ["projects.list", {}],
    ["sessions.create", { projectId: "p1", title: "New chat" }],
    ["sessions.delete", { projectId: "p1", sessionId: "s1" }]
  ])("validates %s with named params", (method, params) => {
    expect(ProjectRpcRequestSchema.parse({ requestId: `request-${method}`, method, params }).method).toBe(method);
  });

  it("rejects legacy and unknown method forms", () => {
    expect(() => ProjectRpcRequestSchema.parse({ requestId: "r1", method: "sessions.createForProject", params: { projectId: "p1" } })).toThrow();
    expect(() => ProjectRpcRequestSchema.parse({ requestId: "r1", method: "projects.get", params: { projectId: "p1" }, args: [] })).toThrow();
  });
});

describe("job contracts", () => {
  const runPolicy = {
    requestedCapabilities: { agent: true, engineering: false, search: false },
    toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "offline" } }
  } as const;
  it("keeps the complete public status vocabulary and reports an idempotent receipt's actual status", () => {
    expect(JOB_STATUSES_V2).toEqual([
      "queued",
      "running",
      "pause_requested",
      "paused",
      "cancel_requested",
      "aborted",
      "interrupted",
      "blocked",
      "failed",
      "completed"
    ]);
    expect(
      JobReceiptSchema.parse({
        jobId: "j1",
        projectId: "p1",
        kind: "research_loop",
        status: "queued",
        queuePosition: 0,
        acceptedAt: timestamp,
        projectRevision: 4
      }).status
    ).toBe("queued");
    expect(
      JobReceiptSchema.parse({
        jobId: "j1",
        projectId: "p1",
        kind: "research_loop",
        status: "completed",
        acceptedAt: timestamp,
        projectRevision: 4
      })
    ).not.toHaveProperty("queuePosition");
  });

  it.each([
    ["chat.enqueue", { projectId: "p1", sessionId: "s1", content: "hello", clientMutationId: "cm1", idempotencyKey: "ik1" }],
    ["loop.start", { projectId: "p1", idempotencyKey: "ik2", ...runPolicy }],
    ["loop.pause", { projectId: "p1", jobId: "j1", expectedProjectRevision: 2 }],
    ["loop.resume", { projectId: "p1", interruptedJobId: "j1", checkpointId: "c1", expectedProjectRevision: 2, idempotencyKey: "ik3", ...runPolicy }],
    ["loop.abort", { projectId: "p1", jobId: "j1", expectedProjectRevision: 2 }],
    ["jobs.get", { projectId: "p1", jobId: "j1" }],
    ["jobs.list", { projectId: "p1" }]
  ])("validates %s", (method, params) => {
    expect(JobRpcRequestSchema.parse({ requestId: `request-${method}`, method, params }).method).toBe(method);
  });

  it("strictly validates bounded jobs.get trace pages", () => {
    const valid = {
      requestId: "request-job-trace-page",
      method: "jobs.get",
      params: { projectId: "p1", jobId: "j1", tracePage: { category: "toolAttempts", cursor: "eyJ2IjoxfQ", limit: 200 } }
    };
    expect(JobRpcRequestSchema.parse(valid)).toMatchObject(valid);
    for (const tracePage of [
      { category: "unknown" },
      { category: "toolAttempts", cursor: "not base64url!" },
      { category: "toolAttempts", cursor: "a".repeat(2_049) },
      { category: "toolAttempts", limit: 0 },
      { category: "toolAttempts", limit: 201 },
      { category: "toolAttempts", extra: true }
    ]) {
      expect(JobRpcRequestSchema.safeParse({ ...valid, params: { projectId: "p1", jobId: "j1", tracePage } }).success).toBe(false);
    }
  });

  it("requires an explicit capability and source/OpenCode policy for research runs", () => {
    expect(JobRpcRequestSchema.safeParse({ requestId: "r-start", method: "loop.start", params: { projectId: "p1", idempotencyKey: "ik" } }).success).toBe(
      false
    );
    expect(
      JobRpcRequestSchema.safeParse({
        requestId: "r-start",
        method: "loop.start",
        params: { projectId: "p1", idempotencyKey: "ik", ...runPolicy, requestedCapabilities: { agent: true } }
      }).success
    ).toBe(false);
    expect(
      JobRpcRequestSchema.safeParse({
        requestId: "r-resume",
        method: "loop.resume",
        params: { projectId: "p1", interruptedJobId: "j1", idempotencyKey: "ik-resume", ...runPolicy }
      }).success
    ).toBe(false);
  });

  it("rejects internal, wildcard, and IP literals as discovery domains", () => {
    for (const domain of ["localhost", "service.internal", "*.example.edu", "127.0.0.1"]) {
      expect(
        JobRpcRequestSchema.safeParse({
          requestId: `r-domain-${domain}`,
          method: "loop.start",
          params: {
            projectId: "p1",
            idempotencyKey: "ik-domain",
            requestedCapabilities: { agent: true, engineering: false, search: true },
            toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "discovery", allowedDomains: [domain] } }
          }
        }).success
      ).toBe(false);
    }
  });

  it("rejects credential-bearing and query-bearing URLs before they can enter a durable job policy", () => {
    for (const url of ["https://user:password@example.edu/source", "https://example.edu/source?token=secret", "https://example.edu/source?id=public"]) {
      expect(
        JobRpcRequestSchema.safeParse({
          requestId: "r-sensitive-url",
          method: "loop.start",
          params: {
            projectId: "p1",
            idempotencyKey: "ik-sensitive-url",
            requestedCapabilities: { agent: true, engineering: false, search: true },
            toolPolicy: { allowCodexCli: false, sourceAccess: { mode: "allowlist", urls: [url] } }
          }
        }).success
      ).toBe(false);
    }
  });
});

describe("SSE event contracts", () => {
  const common = { id: 1, projectId: "p1", projectRevision: 2, occurredAt: timestamp };

  it("exposes only the six canonical event names", () => {
    expect(SSE_EVENT_NAMES_V2).toEqual([
      "project.snapshot.changed",
      "chat.message.appended",
      "run.status.changed",
      "run.step.changed",
      "tool.run.changed",
      "artifact.created"
    ]);
  });

  it.each([
    ["project.snapshot.changed", { snapshotVersion: 2, reason: "job_changed" }],
    [
      "chat.message.appended",
      {
        sessionId: "s1",
        message: {
          id: "m1",
          projectId: "p1",
          sessionId: "s1",
          role: "assistant",
          content: "done",
          createdAt: timestamp
        }
      }
    ],
    ["run.status.changed", { jobId: "j1", status: "running" }],
    ["run.step.changed", { jobId: "j1", step: "EXECUTE_TOOLS" }],
    ["tool.run.changed", { jobId: "j1", decisionId: "d1", attemptId: "t1", ordinal: 0, toolName: "WebSearch", status: "completed" }],
    ["artifact.created", { jobId: "j1", artifactId: "a1", name: "report.md", kind: "report" }]
  ])("validates %s", (type, data) => {
    expect(SseEventSchema.parse({ ...common, type, data }).type).toBe(type);
  });

  it("rejects legacy event names and non-monotonic identifiers", () => {
    expect(() => SseEventSchema.parse({ ...common, type: "job.updated", data: {} })).toThrow();
    expect(() => SseEventSchema.parse({ ...common, id: 0, type: "run.status.changed", data: { jobId: "j1", status: "running" } })).toThrow();
  });
});
