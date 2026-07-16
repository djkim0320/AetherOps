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

  it("does not advertise native adapters before durable runtime receipts are supported", () => {
    const configured = {
      ...strictTestSettings,
      allowCodeExecution: true,
      engineeringTools: {
        ...strictTestSettings.engineeringTools,
        enabled: true,
        xfoil: { ...strictTestSettings.engineeringTools.xfoil, enabled: true, command: "xfoil" }
      }
    };
    expect(describeEngineeringProgramCapabilities(configured).find((item) => item.kind === "xfoil-polar")).toMatchObject({
      ready: false,
      blockedReason: expect.stringContaining("runtime-version receipt")
    });
    expect(describeEngineeringProgramCapabilities(configured).find((item) => item.kind === "toolchain-check")).toMatchObject({
      ready: false,
      blockedReason: expect.stringMatching(/all.*NOT_READY/i)
    });
  });
});
