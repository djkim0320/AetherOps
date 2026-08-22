import type { ContextProfile, JsonRecord, ModelOption, Speed } from "./types";

export type RunSelection = {
  model: string;
  effort: string;
  speed: Speed;
  contextProfile: ContextProfile;
  option: ModelOption | null;
};

function configuredDefault(status: JsonRecord | null, key: string): string {
  const value = status?.default_run_configuration;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const candidate = (value as JsonRecord)[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

// The selector may render before preferences are synchronized with the status
// response. Resolve the exact values used by both the UI and API payload so a
// visible fallback can never be sent as an empty or unsupported configuration.
export function resolveRunSelection(
  status: JsonRecord | null,
  options: ModelOption[],
  requested: {
    model: string;
    effort: string;
    speed: Speed;
    contextProfile: ContextProfile;
  }
): RunSelection {
  const defaultModel = configuredDefault(status, "model");
  const option =
    options.find((candidate) => candidate.id === requested.model) ??
    options.find((candidate) => candidate.id === defaultModel) ??
    options[0] ??
    null;

  if (!option) {
    return { model: "", effort: "", speed: "standard", contextProfile: "default", option: null };
  }

  const defaultEffort = configuredDefault(status, "reasoning_effort");
  const effort = option.supported_reasoning_efforts.includes(requested.effort)
    ? requested.effort
    : option.supported_reasoning_efforts.includes(defaultEffort)
      ? defaultEffort
      : option.default_reasoning_effort || option.supported_reasoning_efforts[0] || "";

  const defaultSpeed = configuredDefault(status, "speed");
  const speedCandidates: string[] = [requested.speed, defaultSpeed, "standard"];
  const speed = (speedCandidates.find((candidate) =>
    option.supported_speeds.includes(candidate as Speed)
  ) ?? option.supported_speeds[0] ?? "standard") as Speed;

  return {
    model: option.id,
    effort,
    speed,
    contextProfile:
      option.id === "gpt-5.6-sol" && requested.contextProfile === "long_1m" ? "long_1m" : "default",
    option
  };
}
