import { describe, expect, it } from "vitest";
import { assessCodex } from "../../scripts/doctor/assessments.mjs";
import { normalizedCodexSettings } from "../../scripts/doctor/settings.mjs";

const readyEnvironment = {
  authenticated: true,
  sandbox: { ready: true, cliAvailable: true, status: "ready", mode: "platform-default" }
};

describe("doctor Codex settings assessment", () => {
  it("uses the runtime defaults when persisted Codex fields are absent", () => {
    expect(normalizedCodexSettings({})).toMatchObject({
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      timeoutMs: 180_000,
      taskTimeoutMs: 600_000,
      configured: false,
      configurationSource: "default",
      defaultsApplied: { model: true, reasoningEffort: true, timeoutMs: true, taskTimeoutMs: true }
    });

    expect(assessCodex({}, readyEnvironment)).toMatchObject({
      ready: true,
      status: "access_not_checked",
      configured: false,
      catalog: "supported",
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
      access: "not_checked"
    });
  });

  it("does not misclassify a supported legacy model whose effort was omitted", () => {
    const assessment = assessCodex({ openCodeLlm: { model: "gpt-5.6-sol", timeoutMs: 240_000 } }, readyEnvironment);

    expect(assessment).toMatchObject({
      ready: true,
      status: "access_not_checked",
      configured: true,
      configurationSource: "legacy",
      catalog: "supported",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      defaultsApplied: { reasoningEffort: true }
    });
  });

  it("fails explicitly for unsupported persisted values instead of replacing them", () => {
    expect(assessCodex({ codex: { model: "gpt-5.5-codex", reasoningEffort: "high" } }, readyEnvironment)).toMatchObject({
      ready: false,
      status: "unsupported_model",
      catalog: "unsupported",
      model: "gpt-5.5-codex"
    });
    expect(assessCodex({ codex: { model: "gpt-5.5", reasoningEffort: "max" } }, readyEnvironment)).toMatchObject({
      ready: false,
      status: "unsupported_reasoning_effort",
      catalog: "supported",
      reasoningEffort: "max"
    });
    expect(assessCodex({ codex: { model: null, reasoningEffort: "high" } }, readyEnvironment)).toMatchObject({
      ready: false,
      status: "unsupported_model",
      catalog: "unsupported",
      model: null,
      defaultsApplied: { model: false }
    });
    expect(assessCodex({ codex: { model: "gpt-5.6", reasoningEffort: "high", timeoutMs: null } }, readyEnvironment)).toMatchObject({
      ready: false,
      status: "unsupported_timeout",
      timeoutMs: null,
      defaultsApplied: { timeoutMs: false }
    });
    expect(assessCodex({ codex: [] }, readyEnvironment)).toMatchObject({
      ready: false,
      status: "invalid_codex_settings",
      settingsValid: false
    });
  });

  it("keeps local readiness, authentication, and account access as separate states", () => {
    expect(assessCodex({}, readyEnvironment)).toMatchObject({
      ready: true,
      available: false,
      authenticated: true,
      access: "not_checked",
      status: "access_not_checked"
    });
    expect(assessCodex({}, { ...readyEnvironment, access: "unavailable" })).toMatchObject({
      ready: true,
      available: false,
      authenticated: true,
      access: "unavailable",
      status: "access_unavailable"
    });
    expect(assessCodex({}, { ...readyEnvironment, access: "available" })).toMatchObject({
      ready: true,
      available: true,
      authenticated: true,
      access: "available",
      status: "available"
    });
    expect(assessCodex({}, { ...readyEnvironment, authenticated: false })).toMatchObject({
      ready: false,
      available: false,
      settingsValid: true,
      orchestratorValid: true,
      authenticated: false,
      access: "not_checked",
      status: "unauthenticated"
    });
  });

  it("reports retired provider inputs separately from catalog validity", () => {
    expect(assessCodex({ codex: { model: "gpt-5.6", reasoningEffort: "high", source: "api" } }, readyEnvironment)).toMatchObject({
      ready: false,
      settingsValid: true,
      orchestratorValid: false,
      catalog: "supported",
      authenticated: true,
      access: "not_checked",
      status: "invalid_non_codex_orchestrator"
    });
  });

  it("matches legacy task-timeout inheritance without changing explicit values", () => {
    expect(normalizedCodexSettings({ openCodeLlm: { model: "gpt-5.6-sol" }, openCode: { timeoutMs: 720_000 } })).toMatchObject({
      taskTimeoutMs: 720_000,
      defaultsApplied: { taskTimeoutMs: true }
    });
    expect(normalizedCodexSettings({ openCodeLlm: { model: "gpt-5.6-sol", taskTimeoutMs: 610_000 }, openCode: { timeoutMs: 720_000 } })).toMatchObject({
      taskTimeoutMs: 610_000,
      defaultsApplied: { taskTimeoutMs: false }
    });
  });
});
