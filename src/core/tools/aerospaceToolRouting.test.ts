import { z } from "zod";
import { describe, expect, it } from "vitest";
import { searchAerospaceTools } from "./aerospaceToolRouting.js";
import { getToolDescriptor, type AerospaceToolMetadata, type ToolDescriptor } from "./toolDescriptors.js";

describe("aerospace dynamic tool routing", () => {
  it("loads only the selected schemas from a 1,000-tool catalog", () => {
    const catalog = Array.from({ length: 1_000 }, (_, index) => tool(index));
    const result = searchAerospaceTools(catalog, request("marker-0777 aerodynamic polar"));
    expect(result.catalogSize).toBe(1_000);
    expect(result.loadedSchemaCount).toBe(5);
    expect(result.selected[0]?.descriptor.name).toBe("aero.synthetic.marker-0777");
    expect(result.loadedSchemaBytes).toBe(5_000);
  });

  it("achieves deterministic held-out top-5 recall without catalog-specific branches", () => {
    const catalog = Array.from({ length: 1_000 }, (_, index) => tool(index));
    const expected = Array.from({ length: 20 }, (_, index) => (index * 47 + 13) % 1_000);
    const recalled = expected.filter((index) =>
      searchAerospaceTools(catalog, request(`marker-${String(index).padStart(4, "0")} validation`)).selected.some((item) =>
        item.descriptor.name.endsWith(`marker-${String(index).padStart(4, "0")}`)
      )
    );
    expect(recalled).toHaveLength(expected.length);
  });

  it("hard-filters capability, license, risk, fidelity and frame mismatches", () => {
    const catalog = [
      tool(1, { requiredCapabilities: ["engineering"] }),
      tool(2, { aerospace: { ...metadata(2), licenseRequirement: "commercial" } }),
      tool(3, { aerospace: { ...metadata(3), externalSideEffectRisk: "mutating" } }),
      tool(4, { aerospace: { ...metadata(4), fidelity: 4 } }),
      tool(5, { aerospace: { ...metadata(5), frameKinds: ["body"] } })
    ];
    const result = searchAerospaceTools(catalog, request("validation"));
    expect(result.selected).toEqual([]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "capability denied: engineering",
      "license unavailable",
      "side-effect risk exceeds policy",
      "fidelity exceeds current study policy",
      "frame contract mismatch"
    ]);
  });

  it("attaches aerospace metadata to the existing engineering descriptor", () => {
    expect(getToolDescriptor("EngineeringProgramTool")?.aerospace).toMatchObject({
      discipline: "aerodynamics",
      fidelity: 2,
      externalSideEffectRisk: "bounded_compute"
    });
  });
});

function request(objective: string) {
  return {
    objective,
    disciplines: ["aerodynamics" as const],
    requiredQuantityKinds: ["Mach"],
    requiredFrameKinds: ["wind"],
    allowedCapabilities: [] as const,
    maximumFidelity: 2 as const,
    allowedLicenses: ["none" as const],
    maximumRisk: "none" as const,
    limit: 5
  };
}

function tool(index: number, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  const marker = `marker-${String(index).padStart(4, "0")}`;
  return {
    name: `aero.synthetic.${marker}`,
    version: "1",
    phase: "analysis",
    requiredCapabilities: [],
    inputSchema: z.object({ value: z.number() }).strict(),
    dependencies: [],
    sideEffects: [],
    repeatable: true,
    description: `${marker} deterministic aerodynamic validation`,
    aerospace: metadata(index),
    ...overrides
  };
}

function metadata(index: number): AerospaceToolMetadata {
  return {
    discipline: "aerodynamics",
    fidelity: 1,
    intendedUses: [`marker-${String(index).padStart(4, "0")} aerodynamic polar validation`],
    validInputEnvelope: "public subsonic research fixture",
    quantityKinds: ["Mach", "Reynolds"],
    frameKinds: ["wind", "body"],
    deterministic: true,
    solverRequirements: [],
    licenseRequirement: "none",
    resourceBudget: { cpuSeconds: 1, memoryBytes: 1_000_000, diskBytes: 1_000_000, wallClockMs: 1_000 },
    inputArtifactTypes: ["fixture"],
    outputArtifactTypes: ["receipt"],
    preconditions: ["units_valid"],
    postconditions: ["output_verified"],
    verificationStrategy: "independent fixture oracle",
    supportsUncertainty: false,
    supportsSensitivity: false,
    qualificationStatus: "verified_fixture",
    externalSideEffectRisk: "none",
    schemaByteEstimate: 1_000
  };
}
