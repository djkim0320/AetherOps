import { readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { describeEngineeringProgramCapabilities, hasExecutableEngineeringTool, inspectConfiguredMeshArtifact } from "./engineeringProgramTool.js";
import { nowIso } from "../shared/ids.js";
import type {
  AppSettings,
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
    blockers.push({ key: "engineeringPrograms", message: "No configured XFOIL, modeling artifact root, OpenFOAM case, SU2 case, FreeCAD script, OpenVSP script, or commercial CFD adapter is available." });
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
      if (extension !== ".obj" && extension !== ".stl") continue;
      const stats = safeStat(childPath);
      if (!stats?.isFile()) continue;
      const relativePath = normalizeRelativePath(relative(root, childPath));
      const validation = validateArtifactCandidate(settings, relativePath, stats.size);
      candidates.push({
        relativePath,
        fileName: entry.name,
        format: extension === ".obj" ? "obj" : "stl",
        byteLength: stats.size,
        validated: validation.validated,
        ready: validation.ready,
        blockedReason: validation.blockedReason
      });
    }
  }

  const sorted = candidates.sort((left, right) => Number(right.ready) - Number(left.ready) || left.relativePath.localeCompare(right.relativePath));
  if (!sorted.length) {
    return { candidates: sorted, blockedReason: `No OBJ/STL artifacts were found under the configured modeling artifact root: ${root}` };
  }
  if (!readyArtifactCandidate(sorted)) {
    return { candidates: sorted, blockedReason: "No parser-valid OBJ/STL artifact candidate is available under the configured modeling root within maxMeshBytes." };
  }
  return { candidates: sorted };
}

function validateArtifactCandidate(
  settings: AppSettings,
  relativePath: string,
  byteLength: number
): { ready: boolean; validated: boolean; blockedReason?: string } {
  const maxBytes = settings.engineeringTools.modeling.maxMeshBytes;
  if (byteLength > maxBytes) {
    return { ready: false, validated: false, blockedReason: `exceeds maxMeshBytes (${byteLength} > ${maxBytes})` };
  }
  try {
    inspectConfiguredMeshArtifact(settings, relativePath);
    return { ready: true, validated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ready: false, validated: false, blockedReason: `mesh validation failed: ${message}` };
  }
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

function readyArtifactCandidate(candidates: EngineeringArtifactCandidate[]): EngineeringArtifactCandidate | undefined {
  for (const candidate of candidates) {
    if (candidate.ready) return candidate;
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
  if (capability.kind === "openfoam-case-run") {
    if (!settings.engineeringTools.openFoam.runArgsTemplate.length) {
      return { ready: false, blockedReason: "OpenFOAM run args template is not configured." };
    }
  }
  if (capability.kind === "su2-case-run") {
    if (!settings.engineeringTools.su2.runArgsTemplate.length) {
      return { ready: false, blockedReason: "SU2 run args template is not configured." };
    }
    if (!settings.engineeringTools.su2.runArgsTemplate.some((arg) => arg.includes("{config}"))) {
      return { ready: false, blockedReason: "SU2 run args template must include {config}." };
    }
  }
  if (capability.kind === "cad-script-run") {
    if (!settings.engineeringTools.freeCad.runArgsTemplate.length) {
      return { ready: false, blockedReason: "FreeCAD run args template is not configured." };
    }
    if (!settings.engineeringTools.freeCad.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
      return { ready: false, blockedReason: "FreeCAD run args template must include {script}." };
    }
  }
  if (capability.kind === "vsp-script-run") {
    if (!settings.engineeringTools.openVsp.runArgsTemplate.length) {
      return { ready: false, blockedReason: "OpenVSP run args template is not configured." };
    }
    if (!settings.engineeringTools.openVsp.runArgsTemplate.some((arg) => arg.includes("{script}"))) {
      return { ready: false, blockedReason: "OpenVSP run args template must include {script}." };
    }
  }
  if (capability.kind === "commercial-cfd-run") {
    const runArgs = commercialRunArgsTemplate(settings, capability.target);
    if (!runArgs.length) return { ready: false, blockedReason: `${commercialTargetLabel(capability.target)} run args template is not configured.` };
    if (runArgs.some((arg) => arg.includes("{input}")) && !readyArtifactCandidate(artifactCandidates)) {
      return { ready: false, blockedReason: `${commercialTargetLabel(capability.target)} args require {input}, but no ready OBJ/STL artifact candidate is available.` };
    }
  }
  return { ready: true };
}

function engineeringTemplateRequest(
  settings: AppSettings,
  capability: EngineeringProgramCapability,
  artifactCandidates: EngineeringArtifactCandidate[]
): EngineeringProgramRequest {
  const artifact = readyArtifactCandidate(artifactCandidates);
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
      reason: artifact
        ? "Inspect a discovered OBJ/STL artifact under the configured modeling artifact root."
        : "Configure at least one real OBJ/STL artifact under the modeling artifact root before requesting mesh inspection."
    };
    if (artifact) request.artifactPath = artifact.relativePath;
    return request;
  }
  if (capability.kind === "xfoil-polar") {
    return {
      kind: "xfoil-polar",
      target: "xfoil",
      naca: "2412",
      reynolds: 1_000_000,
      mach: 0,
      alphaStart: -4,
      alphaEnd: 12,
      alphaStep: 2,
      reason: "Generate an aerodynamic polar with the configured XFOIL executable."
    };
  }
  if (capability.kind === "openfoam-case-run") {
    return {
      kind: "openfoam-case-run",
      target: "openfoam",
      outputFileName: "openfoam-run-output.txt",
      reason: "Run the configured OpenFOAM-compatible command against the configured case root."
    };
  }
  if (capability.kind === "su2-case-run") {
    return {
      kind: "su2-case-run",
      target: "su2",
      outputFileName: "su2-run-output.txt",
      reason: "Run the configured SU2_CFD-compatible command against the configured case config."
    };
  }
  if (capability.kind === "cad-script-run") {
    return {
      kind: "cad-script-run",
      target: "freecad",
      outputFileName: "freecad-script-output.json",
      reason: "Run the configured FreeCAD-compatible headless script with the configured command."
    };
  }
  if (capability.kind === "vsp-script-run") {
    return {
      kind: "vsp-script-run",
      target: "openvsp",
      outputFileName: "openvsp-script-output.json",
      reason: "Run the configured OpenVSP-compatible headless script with the configured command."
    };
  }
  const request: EngineeringProgramRequest = {
    kind: "commercial-cfd-run",
    target: capability.target,
    outputFileName: `${capability.target}-result.txt`,
    reason: `Run the configured ${capability.target} adapter against a real prepared input artifact.`
  };
  if (artifact && commercialRunArgsTemplate(settings, capability.target).some((arg) => arg.includes("{input}"))) {
    request.artifactPath = artifact.relativePath;
  }
  return request;
}

function engineeringTemplateLabel(capability: EngineeringProgramCapability): string {
  if (capability.kind === "toolchain-check") return "Preflight configured toolchain";
  if (capability.kind === "mesh-inspect") return "Inspect mesh artifact";
  if (capability.kind === "xfoil-polar") return "Generate XFOIL polar";
  if (capability.kind === "openfoam-case-run") return "Run OpenFOAM case";
  if (capability.kind === "su2-case-run") return "Run SU2 case";
  if (capability.kind === "cad-script-run") return "Run FreeCAD script";
  if (capability.kind === "vsp-script-run") return "Run OpenVSP script";
  return capability.target === "flightstream" ? "Run FlightStream adapter" : "Run STAR-CCM+ adapter";
}

function commercialRunArgsTemplate(settings: AppSettings, target: EngineeringProgramCapability["target"]): string[] {
  if (target === "flightstream") return settings.engineeringTools.commercialCfd.flightStreamRunArgsTemplate;
  if (target === "starccm") return settings.engineeringTools.commercialCfd.starCcmRunArgsTemplate;
  return [];
}

function commercialTargetLabel(target: EngineeringProgramCapability["target"]): string {
  if (target === "flightstream") return "FlightStream";
  if (target === "starccm") return "STAR-CCM+";
  return String(target);
}
