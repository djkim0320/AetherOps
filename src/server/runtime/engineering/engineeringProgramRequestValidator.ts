import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { resolveConfiguredModelingRoot, resolveInsideRoot } from "./engineeringProgramMeshAdapter.js";
import type { AppSettings, CfdRunSpec, EngineeringProgramRequest, EngineeringProgramTarget } from "../../../core/shared/types.js";

export function normalizeEngineeringProgramRequests(value: unknown): EngineeringProgramRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: EngineeringProgramRequest[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("EngineeringProgramTool request entries must be objects.");
    const request = item as Partial<EngineeringProgramRequest>;
    if (
      request.kind !== "toolchain-check" &&
      request.kind !== "mesh-inspect" &&
      request.kind !== "xfoil-polar" &&
      request.kind !== "xfoil-wasm-polar" &&
      request.kind !== "su2-case-run" &&
      request.kind !== "openvsp-analysis-run" &&
      request.kind !== "xflr5-analysis-run"
    ) {
      throw new Error(`Unsupported EngineeringProgramTool request kind: ${String(request.kind)}`);
    }
    const normalizedTarget = normalizeEngineeringProgramTarget(request.target);
    if (request.target !== undefined && !normalizedTarget) {
      throw new Error(`Unsupported EngineeringProgramTool target: ${String(request.target)}`);
    }
    assertKindTarget(request.kind, normalizedTarget);
    const cfdRunSpec = normalizeEngineeringCfdRunSpec(request.cfdRunSpec);
    if (cfdRunSpec && normalizedTarget && cfdRunSpec.target !== normalizedTarget) {
      throw new Error(`${request.kind} received cfdRunSpec.target=${cfdRunSpec.target}; expected ${normalizedTarget}.`);
    }
    if (cfdRunSpec && !solverAllowedForTarget(cfdRunSpec.solver.name, cfdRunSpec.target)) {
      throw new Error(`${cfdRunSpec.target} CFD execution received incompatible solver ${cfdRunSpec.solver.name}.`);
    }
    if (cfdRunSpec?.geometry.source === "configuredCase" && !cfdRunSpec.geometry.configuredCaseId) {
      throw new Error("cfdRunSpec.geometry.configuredCaseId is required for configuredCase geometry.");
    }
    requests.push({
      kind: request.kind,
      target: normalizedTarget,
      cfdRunSpec,
      artifactPath: typeof request.artifactPath === "string" ? request.artifactPath : undefined,
      sourceUrl: typeof request.sourceUrl === "string" ? request.sourceUrl : undefined,
      coordinateBindingId: typeof request.coordinateBindingId === "string" ? request.coordinateBindingId : undefined,
      outputFileName: typeof request.outputFileName === "string" ? request.outputFileName : undefined,
      naca: typeof request.naca === "string" ? request.naca : undefined,
      reynolds: finiteNumber(request.reynolds),
      mach: finiteNumber(request.mach),
      alphaStart: finiteNumber(request.alphaStart),
      alphaEnd: finiteNumber(request.alphaEnd),
      alphaStep: finiteNumber(request.alphaStep),
      transition: normalizeTransition(request.transition),
      reason: typeof request.reason === "string" ? request.reason : undefined
    });
  }
  return requests;
}

function normalizeTransition(value: EngineeringProgramRequest["transition"]): EngineeringProgramRequest["transition"] {
  if (value === undefined) return undefined;
  if (value.mode === "free") return { mode: "free" };
  if (
    value.mode !== "forced" ||
    !Number.isFinite(value.upperXOverC) ||
    !Number.isFinite(value.lowerXOverC) ||
    value.upperXOverC < 0 ||
    value.upperXOverC > 1 ||
    value.lowerXOverC < 0 ||
    value.lowerXOverC > 1 ||
    !value.sourceEvidenceId.trim()
  ) {
    throw new Error("Forced transition requires source-bound upper and lower x/c locations between 0 and 1.");
  }
  return {
    mode: "forced",
    upperXOverC: value.upperXOverC,
    lowerXOverC: value.lowerXOverC,
    sourceEvidenceId: value.sourceEvidenceId.trim()
  };
}

function normalizeEngineeringCfdRunSpec(value: unknown): CfdRunSpec | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeCfdRunSpec(value);
  if (!normalized) throw new Error("EngineeringProgramTool received an invalid cfdRunSpec.");
  return normalized;
}

export function supportedEngineeringProgramKinds(): EngineeringProgramRequest["kind"][] {
  return ["toolchain-check", "mesh-inspect", "xfoil-polar", "xfoil-wasm-polar", "su2-case-run", "openvsp-analysis-run", "xflr5-analysis-run"];
}

export function normalizeEngineeringProgramTarget(value: unknown): EngineeringProgramTarget | undefined {
  if (value === "all" || value === "xfoil" || value === "xfoil-wasm" || value === "modeling" || value === "su2" || value === "openvsp" || value === "xflr5")
    return value;
  return undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function boundedNumber(value: number | undefined, min: number, max: number, defaultValue: number, label: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return resolved;
}

export function boundedPositiveNumber(value: number | undefined, min: number, max: number, defaultValue: number, label: string): number {
  const resolved = boundedNumber(value, min, max, defaultValue, label);
  if (resolved <= 0 && min > 0) {
    throw new Error(`${label} must be positive.`);
  }
  return resolved;
}

export function safeOutputFileName(value: string | undefined, defaultValue: string): string {
  const candidate = (value?.trim() || defaultValue).replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!candidate || candidate === "." || candidate === "..") return defaultValue;
  return candidate.split(/[\\/]/).pop() ?? defaultValue;
}

export function requestWithCfdSpecDefaults(
  request: EngineeringProgramRequest,
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm">,
  settings: AppSettings
): EngineeringProgramRequest {
  if (!request.cfdRunSpec) return request;
  const spec = validateCfdRunSpecForTarget(request.cfdRunSpec, target, settings);
  const next: EngineeringProgramRequest = {
    ...request,
    cfdRunSpec: spec,
    reynolds: request.reynolds ?? spec.flightCondition.reynolds,
    mach: request.mach ?? spec.flightCondition.mach,
    alphaStart: request.alphaStart ?? spec.flightCondition.alphaStart,
    alphaEnd: request.alphaEnd ?? spec.flightCondition.alphaEnd,
    alphaStep: request.alphaStep ?? spec.flightCondition.alphaStep
  };
  if (spec.geometry.source === "artifact") next.artifactPath = spec.geometry.artifactPath;
  if (spec.geometry.source === "sourceUrl") next.sourceUrl = spec.geometry.sourceUrl;
  if (spec.geometry.source === "naca") next.naca = spec.geometry.naca;
  return next;
}

export function normalizeCfdRunSpec(value: unknown): CfdRunSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CfdRunSpec>;
  const target = normalizeCfdTarget(record.target);
  const geometryRecord = record.geometry && typeof record.geometry === "object" ? record.geometry : undefined;
  const flightRecord = record.flightCondition && typeof record.flightCondition === "object" ? record.flightCondition : {};
  const solverRecord = record.solver && typeof record.solver === "object" ? record.solver : undefined;
  if (!target || !geometryRecord || !solverRecord) return undefined;
  const geometrySource =
    geometryRecord.source === "artifact" ||
    geometryRecord.source === "sourceUrl" ||
    geometryRecord.source === "naca" ||
    geometryRecord.source === "configuredCase"
      ? geometryRecord.source
      : undefined;
  const solverName = normalizeSolverName(solverRecord.name);
  if (!geometrySource || !solverName) return undefined;
  const spec: CfdRunSpec = {
    target,
    geometry: {
      source: geometrySource,
      artifactPath: stringValue(geometryRecord.artifactPath),
      sourceUrl: stringValue(geometryRecord.sourceUrl),
      naca: stringValue(geometryRecord.naca),
      configuredCaseId: stringValue(geometryRecord.configuredCaseId),
      coordinateBindingId: stringValue(geometryRecord.coordinateBindingId),
      description: stringValue(geometryRecord.description)
    },
    flightCondition: {
      reynolds: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).reynolds),
      mach: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).mach),
      alphaStart: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).alphaStart),
      alphaEnd: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).alphaEnd),
      alphaStep: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).alphaStep),
      velocity: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).velocity),
      density: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).density),
      viscosity: finiteNumber((flightRecord as CfdRunSpec["flightCondition"]).viscosity)
    },
    solver: {
      name: solverName,
      model: normalizeSolverModel(solverRecord.model),
      turbulenceModel: normalizeTurbulenceModel(solverRecord.turbulenceModel),
      maxIterations: finiteNumber(solverRecord.maxIterations),
      convergenceTolerance: finiteNumber(solverRecord.convergenceTolerance),
      configOverrides: normalizeConfigOverrides(solverRecord.configOverrides)
    },
    rationale: stringValue(record.rationale)
  };
  if (record.mesh && typeof record.mesh === "object") {
    const mesh = record.mesh;
    const strategy = mesh.strategy === "existing" || mesh.strategy === "toolGenerated" || mesh.strategy === "caseGenerated" ? mesh.strategy : "caseGenerated";
    spec.mesh = {
      strategy,
      artifactPath: stringValue(mesh.artifactPath),
      maxCells: finiteNumber(mesh.maxCells),
      boundaryLayer: typeof mesh.boundaryLayer === "boolean" ? mesh.boundaryLayer : undefined,
      yPlusTarget: finiteNumber(mesh.yPlusTarget),
      notes: stringValue(mesh.notes)
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

export function validateCfdRunSpecForTarget(
  value: CfdRunSpec | undefined,
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm" | "su2" | "openvsp" | "xflr5">,
  settings: AppSettings
): CfdRunSpec {
  if (!value) {
    throw new Error(`${target} CFD execution requires cfdRunSpec; AetherOps will not invent case, mesh, or solver parameters.`);
  }
  const spec = normalizeCfdRunSpec(value);
  if (!spec || spec.target !== target) {
    throw new Error(`${target} CFD execution requires cfdRunSpec.target=${target}.`);
  }
  if (!solverAllowedForTarget(spec.solver.name, target)) {
    throw new Error(`${target} CFD execution received incompatible solver ${spec.solver.name}.`);
  }
  const flight = spec.flightCondition;
  const alphaStart = boundedNumber(flight.alphaStart, -30, 30, -4, "cfdRunSpec.flightCondition.alphaStart");
  const alphaEnd = boundedNumber(flight.alphaEnd, -30, 30, 12, "cfdRunSpec.flightCondition.alphaEnd");
  const alphaStep = boundedPositiveNumber(flight.alphaStep, 0.1, 10, 2, "cfdRunSpec.flightCondition.alphaStep");
  if (alphaEnd < alphaStart) throw new Error("cfdRunSpec.flightCondition requires alphaEnd >= alphaStart.");
  const normalized: CfdRunSpec = {
    ...spec,
    flightCondition: {
      ...flight,
      reynolds: boundedPositiveNumber(flight.reynolds, 1_000, 100_000_000, 1_000_000, "cfdRunSpec.flightCondition.reynolds"),
      mach: boundedNumber(flight.mach, 0, 0.8, 0, "cfdRunSpec.flightCondition.mach"),
      alphaStart,
      alphaEnd,
      alphaStep
    },
    solver: {
      ...spec.solver,
      maxIterations:
        spec.solver.maxIterations === undefined
          ? undefined
          : boundedPositiveNumber(spec.solver.maxIterations, 1, 1_000_000, 1_000, "cfdRunSpec.solver.maxIterations"),
      convergenceTolerance:
        spec.solver.convergenceTolerance === undefined
          ? undefined
          : boundedPositiveNumber(spec.solver.convergenceTolerance, 1e-12, 1, 1e-6, "cfdRunSpec.solver.convergenceTolerance")
    }
  };
  validateCfdGeometry(normalized, target, settings);
  validateCfdMesh(normalized, settings);
  return normalized;
}

export function excerpt(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1200);
}

function validateCfdGeometry(
  spec: CfdRunSpec,
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm" | "su2" | "openvsp" | "xflr5">,
  settings: AppSettings
): void {
  const geometry = spec.geometry;
  if (geometry.source === "naca") {
    if (!geometry.naca || !/^\d{4,5}$/.test(geometry.naca)) throw new Error("cfdRunSpec.geometry.naca must be a 4 or 5 digit NACA code.");
    if (target !== "xfoil" && target !== "xfoil-wasm" && target !== "xflr5") {
      throw new Error(`${target} CFD execution cannot use NACA-only geometry without a configured case or artifact.`);
    }
    return;
  }
  if (geometry.source === "sourceUrl") {
    if (target !== "xfoil-wasm") throw new Error(`${target} CFD execution cannot fetch geometry directly from sourceUrl.`);
    if (!geometry.sourceUrl) throw new Error("cfdRunSpec.geometry.sourceUrl is required.");
    return;
  }
  if (geometry.source === "artifact") {
    if (!geometry.artifactPath) throw new Error("cfdRunSpec.geometry.artifactPath is required.");
    const artifactRoot = resolveConfiguredModelingRoot(settings);
    const targetPath = resolveInsideRoot(artifactRoot, geometry.artifactPath);
    if (!existsSync(targetPath) || !statSync(targetPath).isFile())
      throw new Error(`CFD geometry artifact does not exist under configured root: ${geometry.artifactPath}`);
    if (statSync(targetPath).size > settings.engineeringTools.modeling.maxMeshBytes)
      throw new Error(`CFD geometry artifact exceeds maxMeshBytes: ${geometry.artifactPath}`);
    const extension = extname(targetPath).toLowerCase();
    if ((target === "xfoil" || target === "xfoil-wasm") && extension !== ".dat" && extension !== ".txt") {
      throw new Error(`${target} geometry artifact must be an airfoil coordinate .dat or .txt file.`);
    }
    if (
      (target === "openvsp" || target === "xflr5") &&
      extension !== ".vsp3" &&
      extension !== ".obj" &&
      extension !== ".stl" &&
      extension !== ".dat" &&
      extension !== ".txt"
    ) {
      throw new Error(`${target} geometry artifact must be a prepared .vsp3, OBJ/STL mesh, or airfoil coordinate file.`);
    }
    return;
  }
  if (geometry.source === "configuredCase") {
    if (target !== "su2" && target !== "openvsp" && target !== "xflr5") throw new Error(`${target} does not support configuredCase geometry.`);
    if (!geometry.configuredCaseId) throw new Error("cfdRunSpec.geometry.configuredCaseId is required for configuredCase geometry.");
  }
}

function assertKindTarget(kind: EngineeringProgramRequest["kind"], target: EngineeringProgramTarget | undefined): void {
  const expected: Partial<Record<EngineeringProgramRequest["kind"], EngineeringProgramTarget>> = {
    "mesh-inspect": "modeling",
    "xfoil-polar": "xfoil",
    "xfoil-wasm-polar": "xfoil-wasm",
    "su2-case-run": "su2",
    "openvsp-analysis-run": "openvsp",
    "xflr5-analysis-run": "xflr5"
  };
  const required = expected[kind];
  if (required && target !== required) throw new Error(`${kind} requires target=${required}; received ${target ?? "missing"}.`);
}

function validateCfdMesh(spec: CfdRunSpec, settings: AppSettings): void {
  if (!spec.mesh?.artifactPath) return;
  const artifactRoot = resolveConfiguredModelingRoot(settings);
  const targetPath = resolveInsideRoot(artifactRoot, spec.mesh.artifactPath);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile())
    throw new Error(`CFD mesh artifact does not exist under configured root: ${spec.mesh.artifactPath}`);
  if (statSync(targetPath).size > settings.engineeringTools.modeling.maxMeshBytes)
    throw new Error(`CFD mesh artifact exceeds maxMeshBytes: ${spec.mesh.artifactPath}`);
  const extension = extname(targetPath).toLowerCase();
  if (extension !== ".obj" && extension !== ".stl" && extension !== ".su2") {
    throw new Error("cfdRunSpec.mesh.artifactPath must point to OBJ, STL, or SU2 mesh data.");
  }
}

function solverAllowedForTarget(solver: CfdRunSpec["solver"]["name"], target: CfdRunSpec["target"]): boolean {
  if (target === "xfoil") return solver === "xfoil";
  if (target === "xfoil-wasm") return solver === "webxfoil-wasm";
  if (target === "su2") return solver === "su2";
  if (target === "openvsp") return solver === "openvsp-vspaero";
  if (target === "xflr5") return solver === "xflr5";
  return false;
}

function normalizeCfdTarget(value: unknown): CfdRunSpec["target"] | undefined {
  if (value === "xfoil" || value === "xfoil-wasm" || value === "su2" || value === "openvsp" || value === "xflr5") return value;
  return undefined;
}

function normalizeSolverName(value: unknown): CfdRunSpec["solver"]["name"] | undefined {
  if (value === "xfoil" || value === "webxfoil-wasm" || value === "su2" || value === "openvsp-vspaero" || value === "xflr5") return value;
  return undefined;
}

function normalizeSolverModel(value: unknown): CfdRunSpec["solver"]["model"] | undefined {
  if (value === "inviscid" || value === "euler" || value === "rans" || value === "panel" || value === "viscous-panel") return value;
  return undefined;
}

function normalizeTurbulenceModel(value: unknown): CfdRunSpec["solver"]["turbulenceModel"] | undefined {
  if (value === "sa" || value === "sst" || value === "kepsilon" || value === "none") return value;
  return undefined;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
