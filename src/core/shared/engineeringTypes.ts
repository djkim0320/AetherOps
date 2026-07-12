import type { ResearchMetadataSettings } from "./settingsTypes.js";

export type EngineeringProgramRequestKind =
  "toolchain-check" | "mesh-inspect" | "xfoil-polar" | "xfoil-wasm-polar" | "su2-case-run" | "openvsp-analysis-run" | "xflr5-analysis-run";
export type EngineeringProgramTarget = "all" | "xfoil" | "xfoil-wasm" | "modeling" | "su2" | "openvsp" | "xflr5";

export interface CfdRunSpec {
  target: Extract<EngineeringProgramTarget, "xfoil" | "xfoil-wasm" | "su2" | "openvsp" | "xflr5">;
  geometry: {
    source: "artifact" | "sourceUrl" | "naca" | "configuredCase";
    artifactPath?: string;
    sourceUrl?: string;
    naca?: string;
    configuredCaseId?: string;
    coordinateBindingId?: string;
    description?: string;
  };
  flightCondition: {
    reynolds?: number;
    mach?: number;
    alphaStart?: number;
    alphaEnd?: number;
    alphaStep?: number;
    velocity?: number;
    density?: number;
    viscosity?: number;
  };
  mesh?: {
    strategy: "existing" | "toolGenerated" | "caseGenerated";
    artifactPath?: string;
    maxCells?: number;
    boundaryLayer?: boolean;
    yPlusTarget?: number;
    notes?: string;
  };
  solver: {
    name: "xfoil" | "webxfoil-wasm" | "su2" | "openvsp-vspaero" | "xflr5";
    model?: "inviscid" | "euler" | "rans" | "panel" | "viscous-panel";
    turbulenceModel?: "sa" | "sst" | "kepsilon" | "none";
    maxIterations?: number;
    convergenceTolerance?: number;
    configOverrides?: Record<string, string | number | boolean>;
  };
  output?: {
    forceCoefficients?: boolean;
    polar?: boolean;
    pressureField?: boolean;
    mesh?: boolean;
  };
  rationale?: string;
}

export interface EngineeringProgramRequest {
  kind: EngineeringProgramRequestKind;
  target?: EngineeringProgramTarget;
  cfdRunSpec?: CfdRunSpec;
  artifactPath?: string;
  sourceUrl?: string;
  coordinateBindingId?: string;
  outputFileName?: string;
  naca?: string;
  reynolds?: number;
  mach?: number;
  alphaStart?: number;
  alphaEnd?: number;
  alphaStep?: number;
  reason?: string;
}

export interface EngineeringProgramCapability {
  kind: EngineeringProgramRequestKind;
  target: EngineeringProgramTarget;
  ready: boolean;
  requiredFields: string[];
  optionalFields: string[];
  description: string;
  blockedReason?: string;
}

export interface EngineeringArtifactCandidate {
  relativePath: string;
  fileName: string;
  format: "obj" | "stl" | "vsp3" | "airfoil-coordinate";
  byteLength: number;
  validated: boolean;
  ready: boolean;
  blockedReason?: string;
}

export interface ResearchMetadataCapability {
  provider: ResearchMetadataSettings["provider"];
  ready: boolean;
  maxResults: number;
  requiredFields: string[];
  optionalFields: string[];
  description: string;
  blockedReason?: string;
}

export interface RuntimeToolDiagnostics {
  executableTools: string[];
  researchMetadata: ResearchMetadataCapability;
  engineeringPrograms: EngineeringProgramCapability[];
  engineeringArtifactCandidates: EngineeringArtifactCandidate[];
  engineeringProgramRequestTemplates: EngineeringProgramRequestTemplate[];
  blockers: Array<{
    key: string;
    message: string;
  }>;
  generatedAt: string;
}

export interface EngineeringProgramRequestTemplate {
  id: string;
  label: string;
  ready: boolean;
  request: EngineeringProgramRequest;
  requiredFields: string[];
  optionalFields: string[];
  description: string;
  blockedReason?: string;
}

export interface EngineeringProgramPreflightResult {
  target: EngineeringProgramTarget;
  status: "completed" | "failed";
  diagnostics?: RuntimeToolDiagnostics;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}
