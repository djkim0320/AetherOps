import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type { EvidenceItem, ResearchArtifact } from "../../core/shared/types.js";
import type { ResearchToolResult } from "../../core/tools/researchToolTypes.js";
import { REQUIRED_CODEX_CLI_VERSION } from "../runtime/codex/bundledCodexCli.js";
import { BUNDLED_WEBXFOIL_RUNTIME, BUNDLED_WEBXFOIL_VERSION } from "../runtime/engineering/engineeringRuntimeVersions.js";

export function requiredVerifiedEngineeringRuntimeVersion(
  result: ResearchToolResult,
  output: ResearchArtifact | EvidenceItem,
  baseline: ConfigurationBaseline,
  program: string
): string {
  const expected = requiredBaselineSolverVersion(baseline, program);
  const actual = requiredRuntimeVersion(result, output, program);
  if (actual !== expected) {
    throw new Error(`Engineering output ${output.id} runtime version ${actual} does not match baseline ${baseline.id} expected version ${expected}.`);
  }
  return actual;
}

function requiredBaselineSolverVersion(baseline: ConfigurationBaseline, program: string): string {
  const keys = program === "xfoil-wasm" ? ["xfoil-wasm", "webxfoil"] : [program];
  const available = keys.flatMap((key) => {
    const version = text(baseline.solverVersions[key]);
    return version ? [{ key, version }] : [];
  });
  if (!available.length) throw new Error(`Configuration baseline ${baseline.id} is missing the ${program} solver version.`);
  if (new Set(available.map((entry) => entry.version)).size !== 1) {
    throw new Error(`Configuration baseline ${baseline.id} has conflicting solver version aliases for ${available.map((entry) => entry.key).join(" and ")}.`);
  }
  return available[0]!.version;
}

function requiredRuntimeVersion(result: ResearchToolResult, output: ResearchArtifact | EvidenceItem, program: string): string {
  if (program === "xfoil-wasm") return requiredWebXfoilRuntimeVersion(result, output);
  if (program === "codex") return requiredCodexCliRuntimeVersion(result, output);
  throw new Error(`Engineering output ${output.id} has no verified runtime version receipt for ${program}; promotion is blocked.`);
}

function requiredWebXfoilRuntimeVersion(result: ResearchToolResult, output: ResearchArtifact | EvidenceItem): string {
  if (result.toolRun.toolName !== "EngineeringProgramTool") {
    throw new Error(`Engineering output ${output.id} has no verified WebXFOIL runtime version receipt.`);
  }
  const metadataRuntime = text(output.metadata?.runtime);
  const metadataVersion = text(output.metadata?.runtimeVersion);
  if (metadataRuntime !== BUNDLED_WEBXFOIL_RUNTIME || !metadataVersion) {
    throw new Error(`Engineering output ${output.id} has no verified WebXFOIL runtime version receipt.`);
  }
  const toolOutput = record(result.toolRun.output) ? result.toolRun.output : undefined;
  const receipts = Array.isArray(toolOutput?.outputs)
    ? toolOutput.outputs.filter((item): item is Record<string, unknown> => record(item) && item.kind === "xfoil-wasm-polar" && item.target === "xfoil-wasm")
    : [];
  if (!receipts.length) throw new Error(`Engineering output ${output.id} has no verified WebXFOIL runtime version receipt.`);
  const versions = receipts.map((receipt) => {
    const summary = record(receipt.summary) ? receipt.summary : undefined;
    const runtime = text(summary?.runtime);
    const version = text(summary?.runtimeVersion);
    if (runtime !== BUNDLED_WEBXFOIL_RUNTIME || !version) {
      throw new Error(`Engineering output ${output.id} has an invalid WebXFOIL runtime version receipt.`);
    }
    return version;
  });
  const unique = new Set(versions);
  if (unique.size !== 1 || versions[0] !== metadataVersion) {
    throw new Error(`Engineering output ${output.id} has conflicting WebXFOIL runtime version receipts.`);
  }
  if (metadataVersion !== BUNDLED_WEBXFOIL_VERSION) {
    throw new Error(`Engineering output ${output.id} was not produced by bundled WebXFOIL ${BUNDLED_WEBXFOIL_VERSION}.`);
  }
  return metadataVersion;
}

function requiredCodexCliRuntimeVersion(result: ResearchToolResult, output: ResearchArtifact | EvidenceItem): string {
  if (result.toolRun.toolName !== "CodexCliTool") {
    throw new Error(`Engineering output ${output.id} has no verified Codex CLI runtime version receipt.`);
  }
  const runOutput = record(result.toolRun.output) ? result.toolRun.output : undefined;
  const runTrace = runOutput && record(runOutput.codexCliTrace) ? runOutput.codexCliTrace : undefined;
  const outputTrace = output.metadata && record(output.metadata.codexCliTrace) ? output.metadata.codexCliTrace : undefined;
  const runVersion = text(runTrace?.cliVersion);
  const outputVersion = text(outputTrace?.cliVersion);
  if (!runVersion || !outputVersion) throw new Error(`Engineering output ${output.id} has no verified Codex CLI runtime version receipt.`);
  if (runVersion !== outputVersion) throw new Error(`Engineering output ${output.id} has conflicting Codex CLI runtime version receipts.`);
  if (runVersion !== REQUIRED_CODEX_CLI_VERSION) {
    throw new Error(`Engineering output ${output.id} was not produced by bundled Codex CLI ${REQUIRED_CODEX_CLI_VERSION}.`);
  }
  return runVersion;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
