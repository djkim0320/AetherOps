import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../runtime/storage/settingsStore.js";
import { toSettingsSaveInput } from "./common.js";

describe("API v2 settings projection", () => {
  it("updates Codex settings without changing the OpenCode engineering configuration", () => {
    const current = {
      ...defaultSettings,
      openCode: {
        enabled: true,
        command: "custom-opencode",
        provider: "custom-provider",
        model: "engineering-model",
        timeoutMs: 321_000
      }
    };

    const next = toSettingsSaveInput(
      {
        codex: { model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 240_000 },
        embedding: {
          provider: current.embedding.provider,
          model: current.embedding.model,
          baseUrl: current.embedding.baseUrl,
          dimensions: current.embedding.dimensions
        },
        search: {
          provider: current.webSearch.provider,
          endpoint: current.webSearch.endpoint,
          timeoutMs: current.webSearch.timeoutMs ?? 10_000
        },
        capabilities: { agent: true, engineering: false, search: false }
      },
      current
    );

    expect(next.openCodeLlm).toEqual({
      source: "codex-oauth",
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      timeoutMs: 240_000
    });
    expect(next.openCode).toEqual(current.openCode);
  });
});
