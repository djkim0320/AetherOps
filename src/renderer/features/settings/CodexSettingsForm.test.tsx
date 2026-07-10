/* @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { SettingsResponse } from "../../../contracts/api-v2/settings.js";
import { settingsApi } from "../../domain/settingsApi.js";
import { CODEX_MODEL_GROUPS, CodexSettingsForm, getCodexSettingsValidationError } from "./CodexSettingsForm.js";

vi.mock("../../domain/settingsApi.js", () => ({ settingsApi: { save: vi.fn() } }));

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = TestResizeObserver;
HTMLElement.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
HTMLElement.prototype.setPointerCapture = vi.fn();
HTMLElement.prototype.releasePointerCapture = vi.fn();

const baseSettings: SettingsResponse = {
  codex: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 180_000 },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 1536, apiKeyConfigured: true },
  search: { provider: "disabled", timeoutMs: 30_000, apiKeyConfigured: false },
  capabilities: { agent: true, engineering: false, search: false },
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("CodexSettingsForm", () => {
  beforeEach(() => vi.mocked(settingsApi.save).mockReset());

  it("shows the selected experimental model's entitlement and preview constraints", () => {
    renderForm({ ...baseSettings, codex: { ...baseSettings.codex, model: "gpt-5.3-codex-spark" } });

    expect(screen.getByRole("region", { name: "Selected model details" }).textContent).toContain("Text-only research preview");
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByText("ChatGPT Pro")).toBeTruthy();
  });

  it("groups the complete model catalog in the Radix Select", () => {
    renderForm(baseSettings);
    const nativeModelSelect = document.querySelectorAll("select")[0] as HTMLSelectElement;
    expect(CODEX_MODEL_GROUPS.map((group) => group.label)).toEqual(["Recommended", "Compatibility", "Experimental"]);
    expect(Array.from(nativeModelSelect.options, (option) => option.text)).toContain("GPT-5.6");
    expect(Array.from(nativeModelSelect.options, (option) => option.text)).toContain("GPT-5.3 Codex Spark");
  });

  it("keeps an incompatible effort selected and blocks saving instead of falling back", async () => {
    renderForm({ ...baseSettings, codex: { ...baseSettings.codex, reasoningEffort: "max" } });
    selectOption("Codex model", "GPT-5.5");

    expect((await screen.findByRole("alert")).textContent).toContain("max reasoning is not supported by gpt-5.5");
    expect(screen.getByRole("combobox", { name: "Reasoning effort" }).textContent).toContain("max");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(settingsApi.save).not.toHaveBeenCalled();
  });

  it("saves the selected effort and accepts the returned settings for query roundtrip", async () => {
    const saved = { ...baseSettings, codex: { ...baseSettings.codex, reasoningEffort: "high" as const }, updatedAt: "2026-07-10T00:01:00.000Z" };
    vi.mocked(settingsApi.save).mockResolvedValue(saved);
    const client = renderForm(baseSettings);
    selectOption("Reasoning effort", "high");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(settingsApi.save).toHaveBeenCalledTimes(1));
    expect(vi.mocked(settingsApi.save).mock.calls[0]?.[0]).toMatchObject({ codex: { model: "gpt-5.6", reasoningEffort: "high" } });
    await waitFor(() => expect(client.getQueryData(["settings"])).toEqual(saved));
  });
});

describe("getCodexSettingsValidationError", () => {
  it("allows max only for the GPT-5.6 family", () => {
    expect(getCodexSettingsValidationError("gpt-5.6-terra", "max", 180_000)).toBeUndefined();
    expect(getCodexSettingsValidationError("gpt-5.4", "max", 180_000)).toContain("not supported");
  });
});

function renderForm(settings: SettingsResponse): QueryClient {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{(<CodexSettingsForm settings={settings} />) as ReactElement}</QueryClientProvider>);
  return client;
}

function selectOption(selectName: string, optionName: string): void {
  const index = selectName === "Codex model" ? 0 : 1;
  const select = document.querySelectorAll("select")[index] as HTMLSelectElement;
  const option = Array.from(select.options).find((candidate) => candidate.text === optionName);
  if (!option) throw new Error(`Missing option: ${optionName}`);
  fireEvent.change(select, { target: { value: option.value } });
}
