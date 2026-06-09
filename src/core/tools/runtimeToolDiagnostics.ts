import { readFileSync, readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { describeEngineeringProgramCapabilities, hasExecutableEngineeringTool, inspectConfiguredMeshArtifact, validateAirfoilCoordinateText } from "./engineeringProgramTool.js";
import { nowIso } from "../shared/ids.js";
import type {
  AppSettings,
  CfdRunSpec,
  EngineeringArtifactCandidate,
  EngineeringProgramCapability,
  EngineeringProgramRequest,
  EngineeringProgramRequestTemplate,
  ResearchMetadataCapability,
  RuntimeToolDiagnostics
} from "../shared/types.js";

const MAX_ARTIFACT_CANDIDATES = 20;
const MAX_ARTIFACT_SCAN_DEPTH = 3;

export function buildRuntimeToolDiagnostics(settings: AppSettings): RuntimeToolDiagnostics {
  const blockers: RuntimeToolDiagnostics["blockers"] = [];
  const researchMetadata = describeResearchMetadataCapability(settings);
  const engineeringPrograms = describeRuntimeEngineeringCapabilities(settings);
  const artifactScan = collectEngineeringArtifactCandidates(settings);
  const engineeringArtifactCandidates = artifactScan.candidates;
  const executableTools = executableRuntimeTools(settings, researchMetadata, engineeringPrograms);

  if (!researchMetadata.ready) {
    blockers.push({ key: "researchMetadata", message: researchMetadata.blockedReason ?? "Research metadata collection is not ready." });
  }
  if (!settings.allowCodeExecution) {
    blockers.push({ key: "codeExecution", message: "Code execution is disabled in app settings." });
  }
  if (settings.allowCodeExecution && !hasExecutableEngineeringTool(settings)) {
    blockers.push({ key: "engineeringPrograms", message: "No embedded XFOIL, bundled XFOIL-WASM, modeling artifact root, SU2 case, OpenVSP runner, or XFLR5 runner is available." });
  }
  if (artifactScan.blockedReason) {
    blockers.push({ key: "engineeringArtifacts", message: artifactScan.blockedReason });
  }

  return {
    executableTools,
    researchMetadata,
    engineeringPrograms,
    engineeringArtifactCandidates,
    engineeringProgramRequestTemplates: engineeringRequestTemplates(settings, engineeringPrograms, engineeringArtifactCandidates),
    blockers,
    generatedAt: nowIso()
  };
}

export function describeResearchMetadataCapability(settings: AppSettings): ResearchMetadataCapability {
  const externalAllowed = Boolean(settings.allowExternalSearch);
  const enabled = Boolean(settings.researchMetadata.enabled);
  const providerSupported = settings.researchMetadata.provider === "openalex";
  const ready = externalAllowed && enabled && providerSupported;
  let blockedReason: string | undefined;
  if (!externalAllowed) blockedReason = "External search is disabled in app settings.";
  else if (!enabled) blockedReason = "Research metadata collection is disabled.";
  else if (!providerSupported) blockedReason = `Unsupported research metadata provider: ${settings.researchMetadata.provider}.`;

  return {
    provider: settings.researchMetadata.provider,
    ready,
    maxResults: settings.researchMetadata.maxResults,
    requiredFields: ["query"],
    optionalFields: ["mailto", "maxResults"],
    description: "Collect paper metadata from the real OpenAlex API and store DOI, authors, abstract, and citation count as traceable research sources.",
    blockedReason
  };
}

function describeRuntimeEngineeringCapabilities(settings: AppSettings): EngineeringProgramCapability[] {
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

function executableRuntimeTools(
  settings: AppSettings,
  researchMetadata: ResearchMetadataCapability,
  engineeringPrograms: EngineeringProgramCapability[]
): string[] {
  const tools: string[] = [];
  const webSearchReady =
    settings.allowExternalSearch &&
    settings.webSearch.provider !== "disabled" &&
    Boolean(settings.webSearch.apiKey || settings.webSearch.apiKeyConfigured);
  const browserReady = settings.allowExternalSearch && settings.browserUse.enabled;
  const engineeringReady = settings.allowCodeExecution && engineeringPrograms.some((capability) => capability.ready);

  if (webSearchReady) tools.push("WebSearchTool");
  if (browserReady) tools.push("BackgroundBrowserTool");
  if (webSearchReady || browserReady) tools.push("WebFetchTool");
  if (researchMetadata.ready) tools.push("ResearchMetadataTool");
  if (settings.allowCodeExecution) tools.push("CodeExecutionTool");
  if (engineeringReady) tools.push("EngineeringProgramTool");
  tools.push("ArtifactWriterTool", "DataAnalysisTool");
  return tools;
}

function collectEngineeringArtifactCandidates(settings: AppSettings): { candidates: EngineeringArtifactCandidate[]; blockedReason?: string } {
  if (!settings.allowCodeExecution || !settings.engineeringTools.enabled || !settings.engineeringTools.modeling.enabled) return { candidates: [] };
  const rootSetting = settings.engineeringTools.modeling.artifactRoot?.trim();
  if (!rootSetting) return { candidates: [], blockedReason: "Modeling artifact root is not configured." };
  const root = resolve(rootSetting);
  const rootStats = safeStat(root);
  if (!rootStats) return { candidates: [], blockedReason: `Configured modeling artifact root does not exist: ${root}` };
  if (!rootStats.isDirectory()) return { candidates: [], blockedReason: `Configured modeling artifact root is not a directory: ${root}` };

  const candidates: EngineeringArtifactCandidate[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length && candidates.length < MAX_ARTIFACT_CANDIDATES) {
    const current = queue.shift() as { directory: string; depth: number };
    const entries = safeReaddirEntries(current.directory).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (candidates.length >= MAX_ARTIFACT_CANDIDATES) break;
      if (entry.isSymbolicLink()) continue;
      const childPath = resolve(current.directory, entry.name);
      if (!isInsideRoot(root, childPath)) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_ARTIFACT_SCAN_DEPTH) queue.push({ directory: childPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      const format = engineeringArtifactFormatFromExtension(extension);
      if (!format) continue;
      const stats = safeStat(childPath);
      if (!stats?.isFile()) continue;
      const relativePath = normalizeRelativePath(relative(root, childPath));
      const validation = validateArtifactCandidate(settings, relativePath, stats.size, format);
      candidates.push({
        relativePath,
        fileName: entry.name,
        format,
        byteLength: stats.size,
        validated: validation.validated,
        ready: validation.ready,
        blockedReason: validation.blockedReason
      });
    }
  }

  const sorted = candidates.sort((left, right) => Number(right.ready) - Number(left.ready) || left.relativePath.localeCompare(right.relativePath));
  if (!sorted.length) {
    return { candidates: sorted, blockedReason: `No OBJ/STL/VSP3 or airfoil coordinate artifacts were found under the configured modeling artifact root: ${root}` };
  }
  if (!readyArtifactCandidate(sorted, ["obj", "stl", "vsp3", "airfoil-coordinate"])) {
    return { candidates: sorted, blockedReason: "No parser-valid OBJ/STL, VSP3, or airfoil coordinate artifact candidate is available under the configured modeling root within maxMeshBytes." };
  }
  return { candidates: sorted };
}

function validateArtifactCandidate(
  settings: AppSettings,
  relativePath: string,
  byteLength: number,
  format: EngineeringArtifactCandidate["format"]
): { ready: boolean; validated: boolean; blockedReason?: string } {
  const maxBytes = settings.engineeringTools.modeling.maxMeshBytes;
  if (byteLength > maxBytes) {
    return { ready: false, validated: false, blockedReason: `exceeds maxMeshBytes (${byteLength} > ${maxBytes})` };
  }
  try {
    if (format === "airfoil-coordinate") {
      const artifactRoot = resolve(settings.engineeringTools.modeling.artifactRoot as string);
      validateAirfoilCoordinateText(readFileSync(resolve(artifactRoot, relativePath), "utf8"));
    } else if (format === "vsp3") {
      if (!relativePath.toLowerCase().endsWith(".vsp3")) throw new Error("OpenVSP artifacts must use .vsp3 extension.");
    } else {
      inspectConfiguredMeshArtifact(settings, relativePath);
    }
    return { ready: true, validated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ready: false, validated: false, blockedReason: `${format === "airfoil-coordinate" ? "airfoil coordinate" : "mesh"} validation failed: ${message}` };
  }
}

function engineeringArtifactFormatFromExtension(extension: string): EngineeringArtifactCandidate["format"] | undefined {
  if (extension === ".obj") return "obj";
  if (extension === ".stl") return "stl";
  if (extension === ".vsp3") return "vsp3";
  if (extension === ".dat" || extension === ".txt") return "airfoil-coordinate";
  return undefined;
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function safeReaddirEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

const CLARK_Y_COORDINATE_URL = "https://m-selig.ae.illinois.edu/ads/coord/clarky.dat";

function readyArtifactCandidate(candidates: EngineeringArtifactCandidate[], formats?: EngineeringArtifactCandidate["format"][]): EngineeringArtifactCandidate | undefined {
  const allowedFormats = formats ? new Set(formats) : undefined;
  for (const candidate of candidates) {
    if (candidate.ready && (!allowedFormats || allowedFormats.has(candidate.format))) return candidate;
  }
  return undefined;
}

function engineeringRequestTemplates(
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
      return { ready: false, blockedReason: "XFOIL-WASM Clark Y URL execution requires external search/direct fetch permission or a ready airfoil coordinate artifact." };
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
      cfdRunSpec: cfdSpecForCaseTarget("su2", meshArtifact?.relativePath),
      reason: "Generate a validated SU2 config from the LLM CFD spec, then run the embedded SU2_CFD executable."
    };
  }
  if (capability.kind === "openvsp-analysis-run") {
    return {
      kind: "openvsp-analysis-run",
      target: "openvsp",
      outputFileName: "openvsp-analysis-output.json",
      cfdRunSpec: cfdSpecForCaseTarget("openvsp", vspArtifact?.relativePath),
      reason: "Run OpenVSP/VSPAERO with the LLM-generated CFD run spec JSON."
    };
  }
  return {
    kind: "xflr5-analysis-run",
    target: "xflr5",
    outputFileName: "xflr5-analysis-output.json",
    cfdRunSpec: airfoilArtifact ? cfdSpecForCaseTarget("xflr5", airfoilArtifact.relativePath) : cfdSpecForXflr5Naca(),
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

function cfdSpecForXfoil(
  target: Extract<CfdRunSpec["target"], "xfoil" | "xfoil-wasm">,
  artifactPath?: string,
  sourceUrl?: string
): CfdRunSpec {
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
  artifactPath?: string
): CfdRunSpec {
  const solverName = target === "su2" ? "su2" : target === "openvsp" ? "openvsp-vspaero" : "xflr5";
  const geometry = artifactPath
    ? { source: "artifact" as const, artifactPath }
    : { source: "configuredCase" as const, description: "Use the configured case or adapter script input; no path is invented by the LLM." };
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
