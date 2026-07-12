import { describeEngineeringProgramCapabilities } from "./engineeringProgramTool.js";
import type {
  AppSettings,
  CfdRunSpec,
  EngineeringArtifactCandidate,
  EngineeringProgramCapability,
  EngineeringProgramRequest,
  EngineeringProgramRequestTemplate
} from "../shared/types.js";

const CLARK_Y_COORDINATE_URL = "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat";

export function describeRuntimeEngineeringCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
  const codeAllowed = Boolean(settings.allowCodeExecution);
  const capabilities = describeEngineeringProgramCapabilities(settings);
  return capabilities.map((capability) => {
    if (codeAllowed) return capability;
    return {
      ...capability,
      ready: false,
      blockedReason: "Code execution is disabled in app settings."
    };
  });
}

export function collectEngineeringArtifactCandidates(settings: AppSettings): { candidates: EngineeringArtifactCandidate[]; blockedReason?: string } {
  if (!settings.allowCodeExecution || !settings.engineeringTools.enabled || !settings.engineeringTools.modeling.enabled) return { candidates: [] };
  const rootSetting = settings.engineeringTools.modeling.artifactRoot?.trim();
  if (!rootSetting) return { candidates: [], blockedReason: "Modeling artifact root is not configured." };
  return {
    candidates: [],
    blockedReason: "Artifact discovery is performed by the server runtime; no validated artifact candidates were supplied to the pure planning core."
  };
}

export function engineeringRequestTemplates(
  settings: AppSettings,
  capabilities: EngineeringProgramCapability[],
  artifactCandidates: EngineeringArtifactCandidate[]
): EngineeringProgramRequestTemplate[] {
  const templates: EngineeringProgramRequestTemplate[] = [];
  for (const capability of capabilities) {
    const readiness = engineeringTemplateReadiness(settings, capability, artifactCandidates);
    templates.push({
      id: `${capability.kind}:${capability.target}`,
      label: engineeringTemplateLabel(capability),
      ready: readiness.ready,
      request: engineeringTemplateRequest(settings, capability, artifactCandidates),
      requiredFields: capability.requiredFields,
      optionalFields: capability.optionalFields,
      description: capability.description,
      blockedReason: readiness.blockedReason
    });
  }
  return templates;
}

function engineeringTemplateReadiness(
  settings: AppSettings,
  capability: EngineeringProgramCapability,
  artifactCandidates: EngineeringArtifactCandidate[]
): { ready: boolean; blockedReason?: string } {
  if (!capability.ready) return { ready: false, blockedReason: capability.blockedReason };
  if (capability.kind === "mesh-inspect" && !readyArtifactCandidate(artifactCandidates)) {
    return { ready: false, blockedReason: "No OBJ/STL artifact candidate is available under the configured modeling root within maxMeshBytes." };
  }
  if (capability.kind === "mesh-inspect" && !readyArtifactCandidate(artifactCandidates, ["obj", "stl"])) {
    return { ready: false, blockedReason: "No OBJ/STL artifact candidate is available under the configured modeling root within maxMeshBytes." };
  }
  if (capability.kind === "su2-case-run") {
    if (!settings.engineeringTools.su2.runArgsTemplate.length) {
      return { ready: false, blockedReason: "SU2 run args template is not configured." };
    }
    if (!settings.engineeringTools.su2.runArgsTemplate.some((arg) => arg.includes("{config}"))) {
      return { ready: false, blockedReason: "SU2 run args template must include {config}." };
    }
  }
  if (capability.kind === "openvsp-analysis-run") {
    if (settings.engineeringTools.openVsp.scriptPath?.trim()) {
      if (!settings.engineeringTools.openVsp.runArgsTemplate.length) {
        return { ready: false, blockedReason: "OpenVSP custom script run args template is not configured." };
      }
      if (!settings.engineeringTools.openVsp.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
        return { ready: false, blockedReason: "OpenVSP custom script run args template must include {script}." };
      }
      if (!settings.engineeringTools.openVsp.runArgsTemplate.some((arg) => arg.includes("{spec}"))) {
        return { ready: false, blockedReason: "OpenVSP custom script run args template must include {spec}." };
      }
    } else if (!readyArtifactCandidate(artifactCandidates, ["vsp3"])) {
      return { ready: false, blockedReason: "Built-in OpenVSP runner requires a ready .vsp3 geometry artifact under the modeling artifact root." };
    }
  }
  if (capability.kind === "xflr5-analysis-run") {
    if (settings.engineeringTools.xflr5.scriptPath?.trim()) {
      if (!settings.engineeringTools.xflr5.runArgsTemplate.length) {
        return { ready: false, blockedReason: "XFLR5 custom script run args template is not configured." };
      }
      if (!settings.engineeringTools.xflr5.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
        return { ready: false, blockedReason: "XFLR5 custom script run args template must include {script}." };
      }
      if (!settings.engineeringTools.xflr5.runArgsTemplate.some((arg) => arg.includes("{spec}"))) {
        return { ready: false, blockedReason: "XFLR5 custom script run args template must include {spec}." };
      }
    }
  }
  if (capability.kind === "xfoil-wasm-polar") {
    const airfoilArtifact = readyArtifactCandidate(artifactCandidates, ["airfoil-coordinate"]);
    if (!airfoilArtifact && !settings.allowExternalSearch) {
      return {
        ready: false,
        blockedReason: "XFOIL-WASM Clark Y URL execution requires external search/direct fetch permission or a ready airfoil coordinate artifact."
      };
    }
  }
  return { ready: true };
}

function engineeringTemplateRequest(
  settings: AppSettings,
  capability: EngineeringProgramCapability,
  artifactCandidates: EngineeringArtifactCandidate[]
): EngineeringProgramRequest {
  const meshArtifact = readyArtifactCandidate(artifactCandidates, ["obj", "stl", "vsp3"]);
  const vspArtifact = readyArtifactCandidate(artifactCandidates, ["vsp3"]);
  const airfoilArtifact = readyArtifactCandidate(artifactCandidates, ["airfoil-coordinate"]);
  if (capability.kind === "toolchain-check") {
    return {
      kind: "toolchain-check",
      target: capability.target,
      reason: "Verify configured engineering program availability before requesting analysis outputs."
    };
  }
  if (capability.kind === "mesh-inspect") {
    const request: EngineeringProgramRequest = {
      kind: "mesh-inspect",
      target: "modeling",
      reason: meshArtifact
        ? "Inspect a discovered OBJ/STL artifact under the configured modeling artifact root."
        : "Configure at least one real OBJ/STL artifact under the modeling artifact root before requesting mesh inspection."
    };
    if (meshArtifact) request.artifactPath = meshArtifact.relativePath;
    return request;
  }
  if (capability.kind === "xfoil-polar") {
    const request: EngineeringProgramRequest = {
      kind: "xfoil-polar",
      target: "xfoil",
      naca: "2412",
      reynolds: 1_000_000,
      mach: 0,
      alphaStart: -4,
      alphaEnd: 12,
      alphaStep: 2,
      cfdRunSpec: cfdSpecForXfoil("xfoil", airfoilArtifact?.relativePath),
      reason: "Generate an aerodynamic polar with the configured XFOIL executable."
    };
    if (airfoilArtifact) {
      delete request.naca;
      request.artifactPath = airfoilArtifact.relativePath;
      request.reason = "Generate an aerodynamic polar from a discovered airfoil coordinate file with the configured XFOIL executable.";
    }
    return request;
  }
  if (capability.kind === "xfoil-wasm-polar") {
    const request: EngineeringProgramRequest = {
      kind: "xfoil-wasm-polar",
      target: "xfoil-wasm",
      sourceUrl: CLARK_Y_COORDINATE_URL,
      reynolds: 1_000_000,
      mach: 0,
      alphaStart: -4,
      alphaEnd: 12,
      alphaStep: 2,
      cfdRunSpec: cfdSpecForXfoil("xfoil-wasm", undefined, CLARK_Y_COORDINATE_URL),
      reason: "Generate a real Clark Y aerodynamic polar with bundled WebXFOIL from the UIUC coordinate file."
    };
    if (airfoilArtifact) {
      delete request.sourceUrl;
      request.artifactPath = airfoilArtifact.relativePath;
      request.cfdRunSpec = cfdSpecForXfoil("xfoil-wasm", airfoilArtifact.relativePath);
      request.reason = "Generate a real aerodynamic polar from a discovered airfoil coordinate file with bundled WebXFOIL.";
    }
    return request;
  }
  if (capability.kind === "su2-case-run") {
    return {
      kind: "su2-case-run",
      target: "su2",
      outputFileName: "su2-run-output.txt",
      cfdRunSpec: cfdSpecForCaseTarget("su2", meshArtifact?.relativePath, "su2:configured-case"),
      reason: "Generate a validated SU2 config from the LLM CFD spec, then run the embedded SU2_CFD executable."
    };
  }
  if (capability.kind === "openvsp-analysis-run") {
    return {
      kind: "openvsp-analysis-run",
      target: "openvsp",
      outputFileName: "openvsp-analysis-output.json",
      cfdRunSpec: cfdSpecForCaseTarget("openvsp", vspArtifact?.relativePath, "openvsp:configured-adapter"),
      reason: "Run OpenVSP/VSPAERO with the LLM-generated CFD run spec JSON."
    };
  }
  return {
    kind: "xflr5-analysis-run",
    target: "xflr5",
    outputFileName: "xflr5-analysis-output.json",
    cfdRunSpec: airfoilArtifact ? cfdSpecForCaseTarget("xflr5", airfoilArtifact.relativePath, "xflr5:configured-adapter") : cfdSpecForXflr5Naca(),
    reason: "Run XFLR5 with the LLM-generated CFD run spec JSON."
  };
}

function engineeringTemplateLabel(capability: EngineeringProgramCapability): string {
  if (capability.kind === "toolchain-check") return "Preflight configured toolchain";
  if (capability.kind === "mesh-inspect") return "Inspect mesh artifact";
  if (capability.kind === "xfoil-polar") return "Generate XFOIL polar";
  if (capability.kind === "xfoil-wasm-polar") return "Generate XFOIL-WASM polar";
  if (capability.kind === "su2-case-run") return "Run SU2 case";
  if (capability.kind === "openvsp-analysis-run") return "Run OpenVSP analysis";
  return "Run XFLR5 analysis";
}

function cfdSpecForXfoil(target: Extract<CfdRunSpec["target"], "xfoil" | "xfoil-wasm">, artifactPath?: string, sourceUrl?: string): CfdRunSpec {
  return {
    target,
    geometry: artifactPath
      ? { source: "artifact", artifactPath }
      : sourceUrl
        ? { source: "sourceUrl", sourceUrl, description: "Public airfoil coordinate file selected by the ready request template." }
        : { source: "naca", naca: "2412", description: "Template NACA airfoil; LLM may replace with a ready airfoil coordinate artifact." },
    flightCondition: {
      reynolds: 1_000_000,
      mach: 0,
      alphaStart: -4,
      alphaEnd: 12,
      alphaStep: 2
    },
    mesh: { strategy: "toolGenerated", boundaryLayer: false },
    solver: {
      name: target === "xfoil" ? "xfoil" : "webxfoil-wasm",
      model: "viscous-panel",
      maxIterations: 160
    },
    output: { polar: true, forceCoefficients: true },
    rationale: "Use XFOIL-family analysis when 2D airfoil polar evidence is sufficient."
  };
}

function cfdSpecForCaseTarget(
  target: Extract<CfdRunSpec["target"], "su2" | "openvsp" | "xflr5">,
  artifactPath?: string,
  configuredCaseId?: string
): CfdRunSpec {
  const solverName = target === "su2" ? "su2" : target === "openvsp" ? "openvsp-vspaero" : "xflr5";
  const geometry = artifactPath
    ? { source: "artifact" as const, artifactPath }
    : {
        source: "configuredCase" as const,
        configuredCaseId: configuredCaseId ?? `${target}:configured-case`,
        description: "Use the explicitly identified configured case or adapter input; no path is invented by the LLM."
      };
  return {
    target,
    geometry,
    flightCondition: {
      reynolds: 1_000_000,
      mach: 0,
      alphaStart: -4,
      alphaEnd: 12,
      alphaStep: 2
    },
    mesh: { strategy: artifactPath ? "existing" : "caseGenerated", artifactPath, boundaryLayer: target === "su2" ? true : undefined },
    solver: {
      name: solverName,
      model: target === "su2" ? "euler" : "panel",
      turbulenceModel: target === "su2" ? "none" : undefined,
      maxIterations: target === "su2" ? 1_000 : undefined,
      convergenceTolerance: target === "su2" ? 1e-6 : undefined
    },
    output: { polar: true, forceCoefficients: true, pressureField: target === "su2" },
    rationale: `Use ${target} when the research plan needs computed aerodynamic/CFD evidence beyond source metadata.`
  };
}

function cfdSpecForXflr5Naca(): CfdRunSpec {
  return {
    target: "xflr5",
    geometry: { source: "naca", naca: "2412", description: "Template NACA airfoil; LLM may replace with a ready airfoil coordinate artifact." },
    flightCondition: {
      reynolds: 1_000_000,
      mach: 0,
      alphaStart: -4,
      alphaEnd: 12,
      alphaStep: 2
    },
    mesh: { strategy: "toolGenerated", boundaryLayer: false },
    solver: {
      name: "xflr5",
      model: "panel",
      maxIterations: 160
    },
    output: { polar: true, forceCoefficients: true },
    rationale: "Use XFLR5 when a local XFLR5 batch run is needed for airfoil polar evidence."
  };
}

function readyArtifactCandidate(
  candidates: EngineeringArtifactCandidate[],
  formats?: EngineeringArtifactCandidate["format"][]
): EngineeringArtifactCandidate | undefined {
  const allowedFormats = formats ? new Set(formats) : undefined;
  for (const candidate of candidates) {
    if (candidate.ready && (!allowedFormats || allowedFormats.has(candidate.format))) return candidate;
  }
  return undefined;
}
