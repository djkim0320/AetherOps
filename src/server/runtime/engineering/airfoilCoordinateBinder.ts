import { createHash } from "node:crypto";
import type { EngineeringProgramRequest, ResearchToolInput, ResearchSource, VerifiedAirfoilCoordinateBinding } from "../../../core/shared/types.js";
import { canonicalHttpUrl } from "../../../core/tools/sourceAccessPolicy.js";
import { validateAirfoilCoordinateText } from "./engineeringProgramCoordinateResolver.js";

export function bindFetchedAirfoilCoordinates(input: ResearchToolInput): ResearchToolInput {
  const plan = input.researchPlan;
  const requests = plan?.programRequests;
  if (!plan || !requests?.length) return input;
  const bindings = [...(input.coordinateBindings ?? [])];
  const boundRequests = requests.map((request) => bindRequest(request, input.sources ?? [], bindings));
  return {
    ...input,
    coordinateBindings: bindings,
    researchPlan: { ...plan, programRequests: boundRequests }
  };
}

function bindRequest(request: EngineeringProgramRequest, sources: ResearchSource[], bindings: VerifiedAirfoilCoordinateBinding[]): EngineeringProgramRequest {
  if (request.kind !== "xfoil-wasm-polar") return request;
  const sourceUrl = request.sourceUrl ?? (request.cfdRunSpec?.geometry.source === "sourceUrl" ? request.cfdRunSpec.geometry.sourceUrl : undefined);
  if (!sourceUrl) return request;
  const source = findFetchedSource(sources, sourceUrl);
  if (!source) throw new Error(`WebXFOIL sourceUrl has no matching completed WebFetchTool source: ${sourceUrl}`);
  const rawText = typeof source.metadata.rawText === "string" ? source.metadata.rawText : "";
  if (!rawText) throw new Error(`WebXFOIL source is missing fetched rawText: ${sourceUrl}`);
  const metrics = validateAirfoilCoordinateText(rawText);
  const sha256 = createHash("sha256").update(rawText, "utf8").digest("hex");
  const id = `airfoil-coordinate:${source.id}:${sha256.slice(0, 16)}`;
  if (!bindings.some((binding) => binding.id === id)) {
    bindings.push({
      id,
      sourceId: source.id,
      sourceUrl: canonicalHttpUrl(sourceUrl) ?? sourceUrl,
      label: source.title,
      sha256,
      rawText,
      pointCount: metrics.pointCount
    });
  }
  return {
    ...request,
    coordinateBindingId: id,
    cfdRunSpec: request.cfdRunSpec ? { ...request.cfdRunSpec, geometry: { ...request.cfdRunSpec.geometry, coordinateBindingId: id } } : request.cfdRunSpec
  };
}

function findFetchedSource(sources: ResearchSource[], sourceUrl: string): ResearchSource | undefined {
  const expected = canonicalHttpUrl(sourceUrl);
  if (!expected) return undefined;
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index];
    if (source && canonicalHttpUrl(source.url ?? "") === expected && source.metadata.fetchStatus === "fetched") return source;
  }
  return undefined;
}
