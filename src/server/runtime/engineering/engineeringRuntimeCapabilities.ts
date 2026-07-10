import type { AppSettings, EngineeringProgramCapability } from "../../../core/shared/types.js";
import { hasConfiguredModelingRoot } from "./engineeringProgramMeshAdapter.js";
import { hasConfiguredOpenVsp, hasConfiguredXflr5 } from "./engineeringProgramScriptedCfdAdapter.js";
import { hasConfiguredSu2 } from "./engineeringProgramSu2Adapter.js";
import { hasConfiguredXfoilWasm } from "./engineeringProgramWebXfoilAdapter.js";
import { hasConfiguredXfoil } from "./engineeringProgramXfoilAdapter.js";

export function hasExecutableEngineeringTool(settings: AppSettings): boolean {
  if (!settings.engineeringTools.enabled) return false;
  return (
    hasConfiguredXfoil(settings) ||
    hasConfiguredXfoilWasm(settings) ||
    hasConfiguredModelingRoot(settings) ||
    hasConfiguredSu2(settings) ||
    hasConfiguredOpenVsp(settings) ||
    hasConfiguredXflr5(settings)
  );
}

export function describeEngineeringProgramCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const toolsEnabled = settings.engineeringTools.enabled;
  const ready = {
    xfoil: toolsEnabled && hasConfiguredXfoil(settings),
    xfoilWasm: toolsEnabled && hasConfiguredXfoilWasm(settings),
    modeling: toolsEnabled && hasConfiguredModelingRoot(settings),
    su2: toolsEnabled && hasConfiguredSu2(settings),
    openVsp: toolsEnabled && hasConfiguredOpenVsp(settings),
    xflr5: toolsEnabled && hasConfiguredXflr5(settings)
  };
  const capabilities: EngineeringProgramCapability[] = [
    {
      kind: "toolchain-check",
      target: "all",
      ready: Object.values(ready).some(Boolean),
      requiredFields: ["kind"],
      optionalFields: ["target", "reason"],
      description: "Probe configured XFOIL, SU2, OpenVSP, and XFLR5 targets and report unavailable targets without inventing substitutes.",
      blockedReason: toolsEnabled ? "No engineering target is configured." : "Engineering program tools are disabled."
    },
    capability(
      "mesh-inspect",
      "modeling",
      ready.modeling,
      ["kind", "artifactPath"],
      ["reason"],
      "Inspect OBJ/STL mesh geometry under the configured modeling artifact root.",
      "Modeling artifact root is not configured."
    ),
    capability(
      "xfoil-polar",
      "xfoil",
      ready.xfoil,
      ["kind", "naca or artifactPath"],
      ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      "Run the embedded XFOIL executable to generate a polar table.",
      "Embedded XFOIL executable is not available under the AetherOps engineering toolchain."
    ),
    capability(
      "xfoil-wasm-polar",
      "xfoil-wasm",
      ready.xfoilWasm,
      ["kind", "naca or artifactPath or sourceUrl"],
      ["reynolds", "mach", "alphaStart", "alphaEnd", "alphaStep", "reason"],
      "Run the bundled WebXFOIL WebAssembly solver to generate a real XFOIL polar without requiring a local xfoil executable.",
      "XFOIL WebAssembly solver is unavailable because engineering program tools are disabled."
    ),
    capability(
      "su2-case-run",
      "su2",
      ready.su2,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Generate a validated SU2 case config from LLM-selected CFD parameters, then run the embedded SU2_CFD-compatible executable.",
      "Embedded SU2 executable is not available, or parser-visible case config is not configured."
    ),
    capability(
      "openvsp-analysis-run",
      "openvsp",
      ready.openVsp,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run the embedded OpenVSP/VSPAERO command through the built-in runner, or through an explicitly configured custom script.",
      "Embedded OpenVSP executable is not available, or the configured custom script contract is invalid."
    ),
    capability(
      "xflr5-analysis-run",
      "xflr5",
      ready.xflr5,
      ["kind", "target", "cfdRunSpec"],
      ["outputFileName", "reason"],
      "Run the embedded XFLR5 command through the built-in runner, or through an explicitly configured custom script.",
      "Embedded XFLR5 executable is not available, or the configured custom script contract is invalid."
    )
  ];
  return capabilities.map((item) => (item.ready ? { ...item, blockedReason: undefined } : item));
}

function capability(
  kind: EngineeringProgramCapability["kind"],
  target: EngineeringProgramCapability["target"],
  ready: boolean,
  requiredFields: string[],
  optionalFields: string[],
  description: string,
  blockedReason: string
): EngineeringProgramCapability {
  return { kind, target, ready, requiredFields, optionalFields, description, blockedReason };
}
