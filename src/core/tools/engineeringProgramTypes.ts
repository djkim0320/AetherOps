import type { CfdRunSpec, EngineeringProgramTarget } from "../shared/types.js";

export interface MeshSummary {
  fileName: string;
  format: "obj" | "stl-ascii" | "stl-binary";
  byteLength: number;
  vertexCount: number;
  faceCount: number;
  triangleCount: number;
  boundingBox?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface CommandProbeResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface XfoilPolarRow {
  alpha: number;
  cl: number;
  cd: number;
  cdp?: number;
  cm?: number;
  topXtr?: number;
  botXtr?: number;
}

export interface XfoilPolarSummary {
  airfoil: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rowCount: number;
  rows: XfoilPolarRow[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface XfoilWasmPolarSummary {
  airfoil: string;
  runtime: "webxfoil-wasm";
  runtimeVersion: string;
  runtimeLicense: "GPL-2.0-or-later";
  sourceKind: "artifact" | "source" | "direct-url" | "naca";
  sourceLabel: string;
  sourceUrl?: string;
  sourceArtifactPath?: string;
  coordinateFormat?: string;
  reynolds: number;
  mach: number;
  alphaStart: number;
  alphaEnd: number;
  alphaStep: number;
  rowCount: number;
  rows: XfoilPolarRow[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
  convergence: {
    hasNaN: boolean;
    hasFortranError: boolean;
    hasConvergenceFail: boolean;
  };
}

export interface AirfoilCoordinateInput {
  text?: string;
  label: string;
  sourceKind: XfoilWasmPolarSummary["sourceKind"];
  sourceUrl?: string;
  sourceArtifactPath?: string;
}

export interface PublicUrlPolicy {
  assertPublicUrl(url: string): Promise<void>;
}

export interface AirfoilCoordinateResolutionPorts {
  publicUrlPolicy: PublicUrlPolicy;
}

export interface Su2Config {
  command?: string;
  caseRoot?: string;
  configFile?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

export interface ScriptedCfdConfig {
  target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">;
  label: string;
  command?: string;
  scriptPath?: string;
  workingDirectory?: string;
  probeArgs: string[];
  runArgsTemplate: string[];
  timeoutMs: number;
}

export interface Su2CaseRunSummary {
  target: "su2";
  command: string;
  args: string[];
  caseRoot: string;
  configPath: string;
  generatedConfigText?: string;
  cfdRunSpec?: CfdRunSpec;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface ScriptedCfdRunSummary {
  target: Extract<EngineeringProgramTarget, "openvsp" | "xflr5">;
  label: string;
  command: string;
  launcherCommand: string;
  args: string[];
  adapterMode: "builtin" | "custom";
  scriptPath?: string;
  builtinAdapterPath?: string;
  geometryPath?: string;
  meshPath?: string;
  cfdSpecPath: string;
  cfdRunSpec: CfdRunSpec;
  workingDirectory?: string;
  outputFileName: string;
  outputTextExcerpt?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}
