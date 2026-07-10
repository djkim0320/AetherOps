import type { CfdRunSpec, EngineeringProgramRequest, RuntimeToolDiagnostics } from "../shared/types.js";
import { normalizeToolName } from "../tools/toolRunner.js";
import { clean } from "./plannerToolSelection.js";

export function normalizeProgramRequests(value: unknown, defaultValue: EngineeringProgramRequest[]): EngineeringProgramRequest[] {
  if (!Array.isArray(value)) return defaultValue;
  const requests: EngineeringProgramRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const request = item as Partial<EngineeringProgramRequest>;
    if (
      request.kind !== "toolchain-check" &&
      request.kind !== "mesh-inspect" &&
      request.kind !== "xfoil-polar" &&
      request.kind !== "xfoil-wasm-polar" &&
      request.kind !== "su2-case-run" &&
      request.kind !== "openvsp-analysis-run" &&
      request.kind !== "xflr5-analysis-run"
    )
      continue;
    const normalized: EngineeringProgramRequest = { kind: request.kind };
    if (
      request.target === "all" ||
      request.target === "xfoil" ||
      request.target === "xfoil-wasm" ||
      request.target === "modeling" ||
      request.target === "su2" ||
      request.target === "openvsp" ||
      request.target === "xflr5"
    ) {
      normalized.target = request.target;
    }
    const cfdRunSpec = normalizeCfdRunSpec(request.cfdRunSpec);
    if (cfdRunSpec) normalized.cfdRunSpec = cfdRunSpec;
    if (typeof request.artifactPath === "string" && request.artifactPath.trim()) {
      normalized.artifactPath = request.artifactPath.trim();
    }
    if (typeof request.sourceUrl === "string" && /^https?:\/\//i.test(request.sourceUrl.trim())) {
      normalized.sourceUrl = request.sourceUrl.trim();
    }
    if (typeof request.outputFileName === "string" && request.outputFileName.trim()) {
      normalized.outputFileName = request.outputFileName.trim();
    }
    if (typeof request.naca === "string" && request.naca.trim()) {
      normalized.naca = request.naca.trim();
    }
    if (typeof request.reynolds === "number" && Number.isFinite(request.reynolds)) normalized.reynolds = request.reynolds;
    if (typeof request.mach === "number" && Number.isFinite(request.mach)) normalized.mach = request.mach;
    if (typeof request.alphaStart === "number" && Number.isFinite(request.alphaStart)) normalized.alphaStart = request.alphaStart;
    if (typeof request.alphaEnd === "number" && Number.isFinite(request.alphaEnd)) normalized.alphaEnd = request.alphaEnd;
    if (typeof request.alphaStep === "number" && Number.isFinite(request.alphaStep)) normalized.alphaStep = request.alphaStep;
    if (typeof request.reason === "string" && request.reason.trim()) {
      normalized.reason = request.reason.trim();
    }
    requests.push(normalized);
    if (requests.length >= 4) break;
  }
  return requests.length ? requests : defaultValue;
}

function normalizeCfdRunSpec(value: unknown): CfdRunSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CfdRunSpec>;
  const geometry = record.geometry && typeof record.geometry === "object" ? record.geometry : undefined;
  const solver = record.solver && typeof record.solver === "object" ? record.solver : undefined;
  if (!geometry || !solver) return undefined;
  if (record.target !== "xfoil" && record.target !== "xfoil-wasm" && record.target !== "su2" && record.target !== "openvsp" && record.target !== "xflr5")
    return undefined;
  if (geometry.source !== "artifact" && geometry.source !== "sourceUrl" && geometry.source !== "naca" && geometry.source !== "configuredCase") return undefined;
  if (solver.name !== "xfoil" && solver.name !== "webxfoil-wasm" && solver.name !== "su2" && solver.name !== "openvsp-vspaero" && solver.name !== "xflr5")
    return undefined;
  const flight = record.flightCondition && typeof record.flightCondition === "object" ? record.flightCondition : {};
  const spec: CfdRunSpec = {
    target: record.target,
    geometry: {
      source: geometry.source,
      artifactPath: clean(geometry.artifactPath),
      sourceUrl: clean(geometry.sourceUrl),
      naca: clean(geometry.naca),
      description: clean(geometry.description)
    },
    flightCondition: {
      reynolds: finiteNumberValue(flight.reynolds),
      mach: finiteNumberValue(flight.mach),
      alphaStart: finiteNumberValue(flight.alphaStart),
      alphaEnd: finiteNumberValue(flight.alphaEnd),
      alphaStep: finiteNumberValue(flight.alphaStep),
      velocity: finiteNumberValue(flight.velocity),
      density: finiteNumberValue(flight.density),
      viscosity: finiteNumberValue(flight.viscosity)
    },
    solver: {
      name: solver.name,
      model:
        solver.model === "inviscid" || solver.model === "euler" || solver.model === "rans" || solver.model === "panel" || solver.model === "viscous-panel"
          ? solver.model
          : undefined,
      turbulenceModel:
        solver.turbulenceModel === "sa" || solver.turbulenceModel === "sst" || solver.turbulenceModel === "kepsilon" || solver.turbulenceModel === "none"
          ? solver.turbulenceModel
          : undefined,
      maxIterations: finiteNumberValue(solver.maxIterations),
      convergenceTolerance: finiteNumberValue(solver.convergenceTolerance),
      configOverrides: normalizeConfigOverrides(solver.configOverrides)
    },
    rationale: clean(record.rationale)
  };
  if (record.mesh && typeof record.mesh === "object") {
    const mesh = record.mesh;
    spec.mesh = {
      strategy: mesh.strategy === "existing" || mesh.strategy === "toolGenerated" || mesh.strategy === "caseGenerated" ? mesh.strategy : "caseGenerated",
      artifactPath: clean(mesh.artifactPath),
      maxCells: finiteNumberValue(mesh.maxCells),
      boundaryLayer: typeof mesh.boundaryLayer === "boolean" ? mesh.boundaryLayer : undefined,
      yPlusTarget: finiteNumberValue(mesh.yPlusTarget),
      notes: clean(mesh.notes)
    };
  }
  if (record.output && typeof record.output === "object") {
    const output = record.output;
    spec.output = {
      forceCoefficients: typeof output.forceCoefficients === "boolean" ? output.forceCoefficients : undefined,
      polar: typeof output.polar === "boolean" ? output.polar : undefined,
      pressureField: typeof output.pressureField === "boolean" ? output.pressureField : undefined,
      mesh: typeof output.mesh === "boolean" ? output.mesh : undefined
    };
  }
  return spec;
}

function normalizeConfigOverrides(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string | number | boolean> = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, 24)) {
    if (!/^[A-Za-z0-9_]{2,80}$/.test(key)) continue;
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") output[key] = rawValue;
  }
  return Object.keys(output).length ? output : undefined;
}

function finiteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readyProgramRequests(requests: EngineeringProgramRequest[], diagnostics: RuntimeToolDiagnostics): EngineeringProgramRequest[] {
  const readyTemplates = new Map(
    diagnostics.engineeringProgramRequestTemplates
      .filter((template) => template.ready)
      .map((template) => [`${template.request.kind}:${template.request.target}`, template.request] as const)
  );
  const readyArtifacts = new Set(diagnostics.engineeringArtifactCandidates.filter((candidate) => candidate.ready).map((candidate) => candidate.relativePath));
  const readyArtifactsByFormat = new Map(
    diagnostics.engineeringArtifactCandidates.filter((candidate) => candidate.ready).map((candidate) => [candidate.relativePath, candidate.format] as const)
  );
  const filtered: EngineeringProgramRequest[] = [];
  for (const request of requests) {
    const target = request.target ?? (targetRequiredForKind(request.kind) ? undefined : defaultTargetForKind(request.kind));
    if (!target) continue;
    const templateRequest = readyTemplates.get(`${request.kind}:${target}`);
    if (!templateRequest) continue;
    const safeRequest = mergeWithReadyProgramTemplate(templateRequest, request, readyArtifacts, readyArtifactsByFormat);
    if (!safeRequest) continue;
    filtered.push(safeRequest);
    if (filtered.length >= 4) break;
  }
  return filtered;
}

function mergeWithReadyProgramTemplate(
  templateRequest: EngineeringProgramRequest,
  request: EngineeringProgramRequest,
  readyArtifacts: Set<string>,
  readyArtifactsByFormat: Map<string, "obj" | "stl" | "vsp3" | "airfoil-coordinate">
): EngineeringProgramRequest | undefined {
  const safeRequest: EngineeringProgramRequest = { ...templateRequest };
  if (request.outputFileName?.trim()) safeRequest.outputFileName = request.outputFileName.trim();
  if (request.reason?.trim()) safeRequest.reason = request.reason.trim();
  if (request.naca?.trim()) safeRequest.naca = request.naca.trim();
  if (request.sourceUrl?.trim() && /^https?:\/\//i.test(request.sourceUrl.trim())) safeRequest.sourceUrl = request.sourceUrl.trim();
  if (request.reynolds !== undefined) safeRequest.reynolds = request.reynolds;
  if (request.mach !== undefined) safeRequest.mach = request.mach;
  if (request.alphaStart !== undefined) safeRequest.alphaStart = request.alphaStart;
  if (request.alphaEnd !== undefined) safeRequest.alphaEnd = request.alphaEnd;
  if (request.alphaStep !== undefined) safeRequest.alphaStep = request.alphaStep;
  if (request.cfdRunSpec) {
    const safeSpec = mergeCfdRunSpecWithReadyArtifacts(safeRequest, request.cfdRunSpec, readyArtifacts, readyArtifactsByFormat);
    if (!safeSpec) return undefined;
    safeRequest.cfdRunSpec = safeSpec;
  }
  if (request.artifactPath?.trim() && readyArtifacts.has(request.artifactPath.trim())) {
    const artifactPath = request.artifactPath.trim();
    const format = readyArtifactsByFormat.get(artifactPath);
    if (artifactFormatAllowedForRequest(safeRequest.kind, format)) safeRequest.artifactPath = artifactPath;
  }
  if ((safeRequest.kind === "xfoil-polar" || safeRequest.kind === "xfoil-wasm-polar") && (safeRequest.artifactPath || safeRequest.sourceUrl)) {
    delete safeRequest.naca;
  }
  if (safeRequest.kind === "mesh-inspect" && !safeRequest.artifactPath) return undefined;
  if (safeRequest.kind === "xfoil-wasm-polar" && !safeRequest.naca && !safeRequest.artifactPath && !safeRequest.sourceUrl) return undefined;
  if (
    (safeRequest.kind === "su2-case-run" || safeRequest.kind === "openvsp-analysis-run" || safeRequest.kind === "xflr5-analysis-run") &&
    !safeRequest.cfdRunSpec
  )
    return undefined;
  return safeRequest;
}

function mergeCfdRunSpecWithReadyArtifacts(
  request: EngineeringProgramRequest,
  spec: CfdRunSpec,
  readyArtifacts: Set<string>,
  readyArtifactsByFormat: Map<string, "obj" | "stl" | "vsp3" | "airfoil-coordinate">
): CfdRunSpec | undefined {
  const target = request.target ?? defaultTargetForKind(request.kind);
  if (!target || spec.target !== target) return undefined;
  const safeSpec: CfdRunSpec = JSON.parse(JSON.stringify(spec)) as CfdRunSpec;
  const geometryArtifact = safeSpec.geometry.artifactPath?.trim();
  if (geometryArtifact) {
    if (!readyArtifacts.has(geometryArtifact)) return undefined;
    const format = readyArtifactsByFormat.get(geometryArtifact);
    if (!artifactFormatAllowedForRequest(request.kind, format)) return undefined;
    safeSpec.geometry.artifactPath = geometryArtifact;
  }
  const meshArtifact = safeSpec.mesh?.artifactPath?.trim();
  if (meshArtifact) {
    if (!readyArtifacts.has(meshArtifact)) return undefined;
    const format = readyArtifactsByFormat.get(meshArtifact);
    if (format !== "obj" && format !== "stl" && format !== "vsp3") return undefined;
    safeSpec.mesh = { strategy: safeSpec.mesh?.strategy ?? "existing", ...safeSpec.mesh, artifactPath: meshArtifact };
  }
  return safeSpec;
}

function artifactFormatAllowedForRequest(kind: EngineeringProgramRequest["kind"], format: "obj" | "stl" | "vsp3" | "airfoil-coordinate" | undefined): boolean {
  if (!format) return false;
  if (kind === "xfoil-polar" || kind === "xfoil-wasm-polar") return format === "airfoil-coordinate";
  if (kind === "mesh-inspect") return format === "obj" || format === "stl";
  if (kind === "openvsp-analysis-run") return format === "obj" || format === "stl" || format === "vsp3" || format === "airfoil-coordinate";
  if (kind === "xflr5-analysis-run") return format === "airfoil-coordinate" || format === "obj" || format === "stl";
  if (kind === "su2-case-run") return format === "obj" || format === "stl";
  return true;
}

function defaultTargetForKind(kind: EngineeringProgramRequest["kind"]): EngineeringProgramRequest["target"] | undefined {
  if (kind === "toolchain-check") return "all";
  if (kind === "mesh-inspect") return "modeling";
  if (kind === "xfoil-polar") return "xfoil";
  if (kind === "xfoil-wasm-polar") return "xfoil-wasm";
  if (kind === "su2-case-run") return "su2";
  if (kind === "openvsp-analysis-run") return "openvsp";
  if (kind === "xflr5-analysis-run") return "xflr5";
  return undefined;
}

function targetRequiredForKind(kind: EngineeringProgramRequest["kind"]): boolean {
  return kind === "su2-case-run" || kind === "openvsp-analysis-run" || kind === "xflr5-analysis-run";
}

export function collectIds(items: Array<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const item of items) ids.push(item.id);
  return ids;
}

export function hasNormalizedTool(tools: string[], normalizedTarget: string): boolean {
  for (const tool of tools) {
    if (normalizeToolName(tool) === normalizedTarget) return true;
  }
  return false;
}
