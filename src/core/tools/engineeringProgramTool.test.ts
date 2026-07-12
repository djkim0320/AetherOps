import { describe, expect, it } from "vitest";
import { strictTestSettings } from "../testing/orchestratorTestHarness.js";
import { describeEngineeringProgramCapabilities, hasExecutableEngineeringTool } from "./engineeringProgramTool.js";

describe("core engineering program capability projection", () => {
  it("exposes bundled WebXFOIL whenever engineering tools are enabled", () => {
    const enabled = { ...strictTestSettings, allowCodeExecution: true, engineeringTools: { ...strictTestSettings.engineeringTools, enabled: false } };
    expect(hasExecutableEngineeringTool(enabled)).toBe(true);
    expect(describeEngineeringProgramCapabilities(enabled).find((item) => item.kind === "xfoil-wasm-polar")).toMatchObject({
      target: "xfoil-wasm",
      ready: true
    });
    const disabled = { ...strictTestSettings, allowCodeExecution: false, engineeringTools: { ...strictTestSettings.engineeringTools, enabled: false } };
    expect(hasExecutableEngineeringTool(disabled)).toBe(false);
    expect(describeEngineeringProgramCapabilities(disabled).find((item) => item.kind === "xfoil-wasm-polar")?.ready).toBe(false);
  });
});
