import { describe, expect, it } from "vitest";
import { EngineeringEnqueueParamsSchema, EngineeringPreflightParamsSchema, EngineeringJobReceiptSchema } from "../../../src/contracts/api-v2/engineering.js";
import { CodexAuthStatusResponseSchema, LlmStatusResponseSchema, ToolsDiagnosticsResponseSchema } from "../../../src/contracts/api-v2/diagnostics.js";
import { ProjectExecutionStateSchema, ProjectSnapshotSchema } from "../../../src/contracts/api-v2/snapshots.js";
import {
  CapabilityGrantSchema,
  CODEX_MODEL_CATALOG,
  CodexSettingsSchema,
  SettingsResponseSchema,
  SettingsSaveParamsSchema
} from "../../../src/contracts/api-v2/settings.js";

const capabilities = { agent: true, engineering: true, search: false } as const;
const now = "2026-07-10T00:00:00.000Z";

describe("API v2 auxiliary contracts", () => {
  it("accepts the catalog and enforces model-specific reasoning efforts", () => {
    for (const descriptor of CODEX_MODEL_CATALOG) {
      expect(CodexSettingsSchema.safeParse({ model: descriptor.id, reasoningEffort: "xhigh", timeoutMs: 60_000, taskTimeoutMs: 600_000 }).success).toBe(true);
    }
    expect(CodexSettingsSchema.safeParse({ model: "gpt-5.6", reasoningEffort: "max", timeoutMs: 60_000, taskTimeoutMs: 600_000 }).success).toBe(true);
    expect(CodexSettingsSchema.safeParse({ model: "gpt-5.5", reasoningEffort: "max", timeoutMs: 60_000, taskTimeoutMs: 600_000 }).success).toBe(false);
    for (const model of ["gpt-5.2", "gpt-5.3-codex", "gpt-5.5-codex", "unknown"]) {
      expect(CodexSettingsSchema.safeParse({ model, reasoningEffort: "xhigh", timeoutMs: 60_000, taskTimeoutMs: 600_000 }).success).toBe(false);
    }
    expect(
      CodexSettingsSchema.safeParse({
        model: "gpt-5.6",
        reasoningEffort: "xhigh",
        timeoutMs: 60_000,
        taskTimeoutMs: 600_000,
        provider: "openai",
        apiKey: "secret"
      }).success
    ).toBe(false);
  });

  it("retains embedding and search secret writes but never exposes response secrets", () => {
    const save = {
      codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 60_000, taskTimeoutMs: 600_000 },
      embedding: { provider: "openai", model: "text-embedding-3-large", dimensions: 3_072, apiKey: "embed-secret" },
      search: { provider: "tavily", endpoint: "https://api.tavily.com/search", timeoutMs: 10_000, apiKey: "search-secret" },
      capabilities
    } as const;
    expect(SettingsSaveParamsSchema.safeParse(save).success).toBe(true);

    const response = {
      codex: save.codex,
      embedding: { provider: "openai", model: "text-embedding-3-large", dimensions: 3_072, apiKeyConfigured: true },
      search: { provider: "tavily", endpoint: "https://api.tavily.com/search", timeoutMs: 10_000, apiKeyConfigured: true },
      capabilities,
      updatedAt: now
    };
    expect(SettingsResponseSchema.safeParse(response).success).toBe(true);
    expect(SettingsResponseSchema.safeParse({ ...response, apiKey: "leaked" }).success).toBe(false);
    expect(SettingsResponseSchema.safeParse({ ...response, codex: { ...response.codex, apiKey: "leaked" } }).success).toBe(false);
    expect(SettingsResponseSchema.safeParse({ ...response, embedding: { ...response.embedding, apiKey: "leaked" } }).success).toBe(false);
    expect(SettingsResponseSchema.safeParse({ ...response, search: { ...response.search, apiKey: "leaked" } }).success).toBe(false);
  });

  it("requires all capability grant dimensions", () => {
    expect(CapabilityGrantSchema.parse(capabilities)).toEqual(capabilities);
    expect(CapabilityGrantSchema.safeParse({ agent: true, engineering: true }).success).toBe(false);
  });

  it("requires a project for engineering enqueue and preflight", () => {
    const enqueue = {
      projectId: "project-1",
      idempotencyKey: "engineering-1",
      requests: [{ target: "xfoil", objective: "Compute a polar", inputs: { naca: "0012" } }],
      requestedCapabilities: capabilities
    };
    expect(EngineeringEnqueueParamsSchema.safeParse(enqueue).success).toBe(true);
    expect(EngineeringEnqueueParamsSchema.safeParse({ ...enqueue, projectId: undefined }).success).toBe(false);
    expect(EngineeringPreflightParamsSchema.safeParse({ projectId: "project-1", targets: ["xfoil"], requestedCapabilities: capabilities }).success).toBe(true);
    expect(EngineeringPreflightParamsSchema.safeParse({ targets: ["xfoil"], requestedCapabilities: capabilities }).success).toBe(false);
    expect(EngineeringEnqueueParamsSchema.safeParse({ ...enqueue, requests: [{ target: "codex", objective: "Implement change", inputs: {} }] }).success).toBe(
      true
    );
    expect(EngineeringEnqueueParamsSchema.safeParse({ ...enqueue, requests: [{ target: "opencode", objective: "legacy", inputs: {} }] }).success).toBe(false);
    expect(
      EngineeringJobReceiptSchema.safeParse({
        jobId: "job-1",
        projectId: "project-1",
        kind: "engineering_run",
        status: "queued",
        queuePosition: 0,
        acceptedAt: now,
        projectRevision: 2
      }).success
    ).toBe(true);
  });

  it("validates execution state and project snapshots", () => {
    const execution = {
      status: "running",
      currentStep: "EXECUTE_TOOLS",
      activeJobId: "job-1",
      lastCheckpointId: "checkpoint-1",
      revision: 4
    } as const;
    expect(ProjectExecutionStateSchema.safeParse(execution).success).toBe(true);
    expect(ProjectSnapshotSchema.safeParse({ projectId: "project-1", revision: 4, execution, updatedAt: now, data: {} }).success).toBe(true);
    expect(ProjectExecutionStateSchema.safeParse({ ...execution, status: "unknown" }).success).toBe(false);
  });

  it("validates diagnostics, Codex auth, and Codex-only LLM status", () => {
    expect(
      ToolsDiagnosticsResponseSchema.safeParse({
        capabilities,
        tools: [{ name: "WebXFOIL", category: "engineering", status: "ready" }],
        generatedAt: now
      }).success
    ).toBe(true);
    expect(CodexAuthStatusResponseSchema.safeParse({ provider: "codex-oauth", status: "authenticated", authenticated: true }).success).toBe(true);
    expect(CodexAuthStatusResponseSchema.safeParse({ provider: "codex-oauth", status: "authenticated", authenticated: false }).success).toBe(false);
    expect(
      LlmStatusResponseSchema.safeParse({
        provider: "codex-oauth",
        model: "gpt-5.6",
        reasoningEffort: "xhigh",
        catalog: "supported",
        access: "not_checked",
        status: "ready",
        available: true
      }).success
    ).toBe(true);
    expect(
      LlmStatusResponseSchema.safeParse({
        provider: "codex-oauth",
        model: "retired-model",
        reasoningEffort: "xhigh",
        catalog: "unsupported",
        access: "not_checked",
        status: "blocked",
        available: false
      }).success
    ).toBe(true);
    expect(
      LlmStatusResponseSchema.safeParse({
        provider: "openai",
        model: "gpt-5.6",
        reasoningEffort: "xhigh",
        catalog: "supported",
        access: "available",
        status: "ready",
        available: true,
        apiKey: "secret"
      }).success
    ).toBe(false);
  });
});
