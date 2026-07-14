import type { CapabilityKind } from "../domain/capabilities/types.js";
import type { AerospaceDiscipline } from "../aerospace/modelCard.js";
import type { AerospaceToolMetadata, ToolDescriptor } from "./toolDescriptors.js";

export interface AerospaceToolSearchRequest {
  objective: string;
  disciplines: readonly AerospaceDiscipline[];
  requiredQuantityKinds: readonly string[];
  requiredFrameKinds: readonly string[];
  allowedCapabilities: readonly CapabilityKind[];
  maximumFidelity: 0 | 1 | 2 | 3 | 4;
  allowedLicenses: readonly AerospaceToolMetadata["licenseRequirement"][];
  maximumRisk: AerospaceToolMetadata["externalSideEffectRisk"];
  limit: number;
}

export interface AerospaceToolSearchResult {
  selected: readonly { descriptor: ToolDescriptor; score: number; reasons: readonly string[] }[];
  rejected: readonly { toolName: string; reason: string }[];
  catalogSize: number;
  loadedSchemaCount: number;
  loadedSchemaBytes: number;
}

const riskOrder: Record<AerospaceToolMetadata["externalSideEffectRisk"], number> = { none: 0, bounded_compute: 1, network: 2, mutating: 3 };

export function searchAerospaceTools(catalog: readonly ToolDescriptor[], request: AerospaceToolSearchRequest): AerospaceToolSearchResult {
  if (!request.objective.trim()) throw new Error("Aerospace tool search objective is required.");
  if (!Number.isSafeInteger(request.limit) || request.limit < 3 || request.limit > 8) throw new Error("Aerospace tool search must load 3 to 8 schemas.");
  const allowedCapabilities = new Set(request.allowedCapabilities);
  const candidates: Array<{ descriptor: ToolDescriptor; score: number; reasons: string[] }> = [];
  const rejected: Array<{ toolName: string; reason: string }> = [];
  for (const descriptor of catalog) {
    const metadata = descriptor.aerospace;
    const rejection = hardRejection(descriptor, metadata, request, allowedCapabilities);
    if (rejection) {
      rejected.push({ toolName: descriptor.name, reason: rejection });
      continue;
    }
    const scored = scoreDescriptor(descriptor, metadata as AerospaceToolMetadata, request);
    candidates.push({ descriptor, score: scored.score, reasons: scored.reasons });
  }
  candidates.sort((left, right) => right.score - left.score || left.descriptor.name.localeCompare(right.descriptor.name));
  const selected = candidates.slice(0, request.limit).map((item) => Object.freeze({ ...item, reasons: Object.freeze(item.reasons) }));
  return Object.freeze({
    selected: Object.freeze(selected),
    rejected: Object.freeze(rejected.sort((left, right) => left.toolName.localeCompare(right.toolName))),
    catalogSize: catalog.length,
    loadedSchemaCount: selected.length,
    loadedSchemaBytes: selected.reduce((total, item) => total + (item.descriptor.aerospace?.schemaByteEstimate ?? 0), 0)
  });
}

function hardRejection(
  descriptor: ToolDescriptor,
  metadata: AerospaceToolMetadata | undefined,
  request: AerospaceToolSearchRequest,
  allowedCapabilities: ReadonlySet<CapabilityKind>
): string | undefined {
  if (!metadata) return "aerospace metadata unavailable";
  if (!request.disciplines.includes(metadata.discipline)) return "discipline mismatch";
  if (metadata.fidelity > request.maximumFidelity) return "fidelity exceeds current study policy";
  if (!request.allowedLicenses.includes(metadata.licenseRequirement)) return "license unavailable";
  if (riskOrder[metadata.externalSideEffectRisk] > riskOrder[request.maximumRisk]) return "side-effect risk exceeds policy";
  const capability = descriptor.requiredCapabilities.find((item) => !allowedCapabilities.has(item));
  if (capability) return `capability denied: ${capability}`;
  if (request.requiredFrameKinds.some((item) => !metadata.frameKinds.includes(item))) return "frame contract mismatch";
  return undefined;
}

function scoreDescriptor(
  descriptor: ToolDescriptor,
  metadata: AerospaceToolMetadata,
  request: AerospaceToolSearchRequest
): { score: number; reasons: string[] } {
  const objectiveTokens = tokens(request.objective);
  const searchable = tokens(
    [descriptor.name, descriptor.description, metadata.validInputEnvelope, ...metadata.intendedUses, ...metadata.quantityKinds].join(" ")
  );
  const lexical = [...objectiveTokens].filter((token) => searchable.has(token)).length;
  const quantityMatches = request.requiredQuantityKinds.filter((item) => metadata.quantityKinds.includes(item)).length;
  const fidelityFit = request.maximumFidelity - metadata.fidelity;
  const deterministicBonus = metadata.deterministic ? 2 : 0;
  const score = lexical * 10 + quantityMatches * 8 + deterministicBonus - fidelityFit;
  return {
    score,
    reasons: [
      `${lexical} objective token matches`,
      `${quantityMatches} quantity contract matches`,
      `fidelity ${metadata.fidelity}`,
      metadata.deterministic ? "deterministic" : "non-deterministic"
    ]
  };
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9가-힣_.-]+/)
      .filter((token) => token.length >= 2)
  );
}
