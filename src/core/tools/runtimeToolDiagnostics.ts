import { nowIso } from "../shared/ids.js";
import { buildProductionExecutableToolNames } from "./toolAvailability.js";
import { collectEngineeringArtifactCandidates, describeRuntimeEngineeringCapabilities, engineeringRequestTemplates } from "./engineeringProgramDiagnostics.js";
import { hasExecutableEngineeringTool } from "./engineeringProgramTool.js";
import type { AppSettings, ResearchMetadataCapability, RuntimeToolDiagnostics } from "../shared/types.js";

export function buildRuntimeToolDiagnostics(
  settings: AppSettings,
  suppliedArtifactScan?: ReturnType<typeof collectEngineeringArtifactCandidates>
): RuntimeToolDiagnostics {
  const blockers: RuntimeToolDiagnostics["blockers"] = [];
  const researchMetadata = describeResearchMetadataCapability(settings);
  const engineeringPrograms = describeRuntimeEngineeringCapabilities(settings);
  const artifactScan = suppliedArtifactScan ?? collectEngineeringArtifactCandidates(settings);
  const engineeringArtifactCandidates = artifactScan.candidates;
  const executableTools = buildProductionExecutableToolNames(settings);

  if (!researchMetadata.ready) {
    blockers.push({ key: "researchMetadata", message: researchMetadata.blockedReason ?? "Research metadata collection is not ready." });
  }
  if (!settings.allowCodeExecution) {
    blockers.push({ key: "engineering", message: "Engineering capability is disabled in app settings." });
  }
  if (settings.allowCodeExecution && !hasExecutableEngineeringTool(settings)) {
    blockers.push({
      key: "engineeringPrograms",
      message: "No embedded XFOIL, bundled XFOIL-WASM, modeling artifact root, SU2 case, OpenVSP runner, or XFLR5 runner is available."
    });
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
