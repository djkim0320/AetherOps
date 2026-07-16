import { closeSync, constants, openSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type { EvidenceItem, ResearchArtifact } from "../../core/shared/types.js";
import type { ResearchToolResult } from "../../core/tools/researchToolTypes.js";
import { aerodynamicReferenceHash, configurationBaselineDependencyHash } from "../runtime/storage/v2/engineeringBaselineIntegrity.js";
import type { StorageEngineeringPromotionDraft } from "../runtime/storage/v2/engineeringBaselineTypes.js";
import {
  MAX_TERMINAL_ARTIFACT_BYTES,
  TerminalCasStore,
  type StorageTerminalCasClaim,
  type StorageTerminalCasClaimOwner,
  type StorageTerminalCasObject
} from "../runtime/storage/v2/terminalCasStore.js";
import { requiredVerifiedEngineeringRuntimeVersion } from "./durableEngineeringRuntimeProvenance.js";
import { polarFactsFromArtifact, requiredWebXfoilPromotionReceipt } from "./durableWebXfoilPromotionReceipt.js";

const POLAR_DEPENDENCIES = [
  "geometry",
  "airfoil_geometry",
  "aerodynamic_reference",
  "atmosphere",
  "solver",
  "source_revision",
  "unit_convention",
  "coordinate_convention"
] as const;

const REPORT_DEPENDENCIES = ["geometry", "mass_properties", "atmosphere", "solver", "source_revision", "unit_convention", "coordinate_convention"] as const;

export interface DurableEngineeringPromotionDraftResult {
  drafts: ReadonlyMap<string, StorageEngineeringPromotionDraft>;
  claims: ReadonlyMap<string, StorageTerminalCasObject>;
  casClaims: readonly StorageTerminalCasClaim[];
}

export class DurableEngineeringPromotionMaterializationError extends Error {
  readonly name = "DurableEngineeringPromotionMaterializationError";

  constructor(
    readonly casClaims: readonly StorageTerminalCasClaim[],
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : "Engineering promotion materialization failed.", { cause });
  }
}

interface PreparedPromotionOutput {
  key: string;
  output: ResearchArtifact | EvidenceItem;
  attemptId: string;
  sourcePath?: string;
  draft: Omit<StorageEngineeringPromotionDraft, "artifact">;
  mediaType: string;
  outputKind: "artifact" | "evidence";
  claimOwner: StorageTerminalCasClaimOwner;
}

export function engineeringPromotionDraftKey(attemptId: string, outputKind: "artifact" | "evidence", outputId: string): string {
  return `${attemptId}\u0000${outputKind}\u0000${outputId}`;
}

export function buildDurableEngineeringPromotionDrafts(input: {
  results: readonly ResearchToolResult[];
  baseline: ConfigurationBaseline;
  dataRoot: string;
  jobId: string;
  executionId: string;
  claimOwners: ReadonlyMap<string, StorageTerminalCasClaimOwner>;
}): DurableEngineeringPromotionDraftResult {
  const cas = new TerminalCasStore(input.dataRoot);
  const prepared: PreparedPromotionOutput[] = [];
  const keys = new Set<string>();
  for (const result of input.results) {
    const attemptId = requiredAttemptOrigin(result, input);
    for (const artifact of result.artifacts) {
      assertOutputOrigin(artifact, result, attemptId, input.baseline.projectId);
      const key = engineeringPromotionDraftKey(attemptId, "artifact", artifact.id);
      assertUniqueOutputKey(keys, key, artifact.id, attemptId);
      assertDeclaredArtifactReceiptShape(artifact);
      const sourcePath = prepareArtifactSource(artifact, result, attemptId, input);
      const draft = preparePromotionDraft(result, artifact, input.baseline);
      const claimOwner = requiredClaimOwner(input, key, "artifact", artifact.id);
      prepared.push({
        key,
        output: artifact,
        attemptId,
        ...(sourcePath ? { sourcePath } : {}),
        draft,
        mediaType: artifact.mimeType,
        outputKind: "artifact",
        claimOwner
      });
    }
    for (const evidence of result.evidence) {
      assertOutputOrigin(evidence, result, attemptId, input.baseline.projectId);
      const key = engineeringPromotionDraftKey(attemptId, "evidence", evidence.id);
      assertUniqueOutputKey(keys, key, evidence.id, attemptId);
      const draft = preparePromotionDraft(result, evidence, input.baseline);
      const claimOwner = requiredClaimOwner(input, key, "evidence", evidence.id);
      prepared.push({
        key,
        output: evidence,
        attemptId,
        draft,
        mediaType: "application/json",
        outputKind: "evidence",
        claimOwner
      });
    }
  }

  const drafts = new Map<string, StorageEngineeringPromotionDraft>();
  const claims = new Map<string, StorageTerminalCasObject>();
  const casClaims: StorageTerminalCasClaim[] = [];
  try {
    for (const item of prepared) {
      const object =
        "relativePath" in item.output
          ? materializeArtifact(cas, item.output, item.claimOwner, item.sourcePath)
          : cas.materializeClaimedBytes(new TextEncoder().encode(canonicalJson(item.output)), item.claimOwner, MAX_TERMINAL_ARTIFACT_BYTES);
      casClaims.push({ object, owner: item.claimOwner });
      claims.set(item.key, object);
      if ("relativePath" in item.output) assertDeclaredArtifactReceipt(item.output, object);
      drafts.set(item.key, {
        ...item.draft,
        artifact: {
          casLocator: object.casLocator,
          sha256: object.casHash,
          byteLength: object.byteLength,
          mediaType: item.mediaType
        }
      });
    }
  } catch (error) {
    throw new DurableEngineeringPromotionMaterializationError(casClaims, error);
  }
  return { drafts, claims, casClaims };
}

function requiredClaimOwner(
  input: {
    baseline: ConfigurationBaseline;
    jobId: string;
    claimOwners: ReadonlyMap<string, StorageTerminalCasClaimOwner>;
  },
  key: string,
  outputKind: "artifact" | "evidence",
  outputId: string
): StorageTerminalCasClaimOwner {
  const owner = input.claimOwners.get(key);
  if (
    !owner ||
    owner.projectId !== input.baseline.projectId ||
    owner.jobId !== input.jobId ||
    !owner.attemptId ||
    owner.outputKind !== outputKind ||
    owner.outputId !== outputId
  ) {
    throw new Error(`Engineering output ${outputId} is missing its durable CAS claim owner.`);
  }
  return owner;
}

function preparePromotionDraft(
  result: ResearchToolResult,
  output: ResearchArtifact | EvidenceItem,
  baseline: ConfigurationBaseline
): Omit<StorageEngineeringPromotionDraft, "artifact"> {
  const isArtifact = "relativePath" in output;
  const program = requiredProgram(result, output);
  const polar = program === "xfoil-wasm" || (isArtifact && program === "xfoil");
  const dependencies = polar ? POLAR_DEPENDENCIES : REPORT_DEPENDENCIES;
  const referenceHash = aerodynamicReferenceHash(baseline);
  const webXfoilReceipt = program === "xfoil-wasm" ? requiredWebXfoilPromotionReceipt(result, output, baseline) : undefined;
  const polarFacts = polar ? (webXfoilReceipt?.facts ?? (isArtifact ? polarFactsFromArtifact(output) : undefined)) : undefined;
  const polarGeometryHash = polar ? requiredPolarGeometryHash(program, webXfoilReceipt, output.id) : undefined;
  const solverVersion = requiredVerifiedEngineeringRuntimeVersion(result, output, baseline, program);
  return {
    resultKind: polar ? "polar" : "engineering_report",
    baselineId: baseline.id,
    baselineRevision: baseline.revision,
    baselineContentHash: baseline.contentHash,
    baselineDependencyHash: configurationBaselineDependencyHash(baseline, dependencies),
    dependencyAspects: dependencies,
    ...(polarGeometryHash ? { geometryHash: polarGeometryHash } : {}),
    ...(polar ? { unitDefinition: { unit: "1", dimension: "dimensionless" } } : {}),
    executionMedia: `${program}@${solverVersion}`,
    ...(referenceHash ? { referenceGeometry: { contentHash: referenceHash } } : {}),
    ...(polarFacts ? { coefficientTypes: polarFacts.coefficientTypes } : {}),
    modelCardId: `model-card:${program}:${solverVersion}`,
    simulationRunReceiptId: `tool-run:${result.toolRun.id}`,
    convergence: polarFacts?.converged ? "converged" : polar ? "failed" : "not_applicable",
    domainAssessment: polarFacts?.withinDeclaredDomain ? "verified" : polar ? "outside_domain" : "not_assessed",
    sensitivity: "project"
  };
}

function requiredPolarGeometryHash(program: string, receipt: ReturnType<typeof requiredWebXfoilPromotionReceipt> | undefined, outputId: string): string {
  if (receipt) return receipt.geometryContentHash;
  throw new Error(
    `Engineering polar output ${outputId} from ${program} is missing a measured airfoil geometry receipt; a baseline geometry hash is not execution evidence.`
  );
}

function requiredProgram(result: ResearchToolResult, output: ResearchArtifact | EvidenceItem): string {
  const program = text(output.metadata?.program);
  const selected = program ?? (result.toolRun.toolName === "CodexCliTool" ? "codex" : undefined);
  if (!selected) throw new Error(`Engineering output ${output.id} is missing its explicit program identity.`);
  if (!requestedPrograms(result).has(selected)) throw new Error(`Engineering output ${output.id} program ${selected} was not authorized by its tool request.`);
  return selected;
}

function prepareArtifactSource(
  artifact: ResearchArtifact,
  result: ResearchToolResult,
  attemptId: string,
  input: { dataRoot: string; jobId: string; executionId: string }
): string | undefined {
  if (typeof artifact.content === "string") return undefined;
  if (!artifact.rawPath) throw new Error(`Engineering artifact ${artifact.id} has no durable content to promote.`);
  return resolveReadyArtifactPath(artifact.rawPath, artifact.relativePath, result.toolRun.toolName, attemptId, input);
}

function materializeArtifact(
  cas: TerminalCasStore,
  artifact: ResearchArtifact,
  claimOwner: StorageTerminalCasClaimOwner,
  sourcePath?: string
): StorageTerminalCasObject {
  if (typeof artifact.content === "string") {
    return cas.materializeClaimedBytes(new TextEncoder().encode(artifact.content), claimOwner, MAX_TERMINAL_ARTIFACT_BYTES);
  }
  if (!sourcePath) throw new Error(`Engineering artifact ${artifact.id} has no validated durable source path.`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(sourcePath, constants.O_RDONLY | noFollow);
  try {
    return cas.materializeClaimedOpenFile(fd, claimOwner, MAX_TERMINAL_ARTIFACT_BYTES);
  } finally {
    closeSync(fd);
  }
}

function resolveReadyArtifactPath(
  rawPath: string,
  declaredRelativePath: string,
  toolName: string,
  attemptId: string,
  input: { dataRoot: string; jobId: string; executionId: string }
): string {
  const attemptPrefix = `${input.executionId}:`;
  if (!attemptId.startsWith(attemptPrefix) || attemptId.length === attemptPrefix.length) throw new Error("Engineering attempt is outside its execution.");
  const actionId = safeSegment(attemptId.slice(attemptPrefix.length));
  const stagingRoot = resolve(input.dataRoot, "staging", "jobs", safeSegment(input.jobId), safeSegment(input.executionId), "actions", actionId);
  const readyRoot = resolve(input.dataRoot, "ready", "jobs", safeSegment(input.jobId), safeSegment(input.executionId), "actions", actionId);
  const raw = resolve(rawPath);
  const readyRelative = scopedRelative(readyRoot, raw);
  if (readyRelative !== undefined) {
    assertDeclaredRelativePath(readyRelative, declaredRelativePath, toolName);
    return raw;
  }
  const stagingRelative = scopedRelative(stagingRoot, raw);
  if (stagingRelative === undefined) throw new Error("Engineering artifact path is outside the isolated execution workspace.");
  assertDeclaredRelativePath(stagingRelative, declaredRelativePath, toolName);
  return resolve(readyRoot, stagingRelative);
}

function assertDeclaredRelativePath(actual: string, declared: string, toolName: string): void {
  if (toolName !== "CodexCliTool") return;
  const normalized = actual.split(sep).join("/");
  const expected = `workspace/outputs/${declared.replace(/\\/g, "/")}`;
  if (normalized !== expected) throw new Error("Codex engineering artifact path does not match its declared output path.");
}

function assertDeclaredArtifactReceipt(artifact: ResearchArtifact, object: StorageTerminalCasObject): void {
  if (!artifact.rawPath) return;
  const { hash, bytes } = declaredArtifactReceipt(artifact);
  if (hash !== object.casHash || bytes !== object.byteLength) {
    throw new Error(`Engineering artifact ${artifact.id} does not match its declared output manifest receipt.`);
  }
}

function assertDeclaredArtifactReceiptShape(artifact: ResearchArtifact): void {
  if (artifact.rawPath) declaredArtifactReceipt(artifact);
}

function declaredArtifactReceipt(artifact: ResearchArtifact): { hash: string; bytes: number } {
  const hash = text(artifact.metadata?.sha256);
  const bytes = artifact.metadata?.bytes;
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(bytes) || Number(bytes) < 0) {
    throw new Error(`Engineering artifact ${artifact.id} has no validated output manifest receipt.`);
  }
  return { hash: hash.toLowerCase(), bytes: Number(bytes) };
}

function assertUniqueOutputKey(keys: Set<string>, key: string, outputId: string, attemptId: string): void {
  if (keys.has(key)) throw new Error(`Engineering output ${outputId} is duplicated within attempt ${attemptId}.`);
  keys.add(key);
}

function requiredAttemptOrigin(result: ResearchToolResult, input: { executionId: string; baseline: ConfigurationBaseline }): string {
  const attemptId = text(result.toolRun.originAttemptId);
  if (
    !attemptId ||
    !attemptId.startsWith(`${input.executionId}:`) ||
    result.toolRun.projectId !== input.baseline.projectId ||
    (result.toolRun.toolName !== "EngineeringProgramTool" && result.toolRun.toolName !== "CodexCliTool")
  ) {
    throw new Error("Engineering result is not bound to the current project execution attempt.");
  }
  return attemptId;
}

function assertOutputOrigin(output: ResearchArtifact | EvidenceItem, result: ResearchToolResult, attemptId: string, projectId: string): void {
  if (output.projectId !== projectId || output.metadata?.originToolAttemptId !== attemptId || result.toolRun.projectId !== projectId) {
    throw new Error(`Engineering output ${output.id} is not bound to its originating project attempt.`);
  }
}

function requestedPrograms(result: ResearchToolResult): Set<string> {
  if (result.toolRun.toolName === "CodexCliTool") return new Set(["codex"]);
  const input = record(result.toolRun.input) ? result.toolRun.input : undefined;
  const requests = Array.isArray(input?.requests) ? input.requests.filter(record) : [];
  const programs: string[] = [];
  for (const request of requests) {
    switch (request.kind) {
      case "mesh-inspect":
        programs.push("modeling");
        break;
      case "xfoil-polar":
        programs.push("xfoil");
        break;
      case "xfoil-wasm-polar":
        programs.push("xfoil-wasm");
        break;
      case "su2-case-run":
        programs.push("su2");
        break;
      case "openvsp-analysis-run":
        programs.push("openvsp");
        break;
      case "xflr5-analysis-run":
        programs.push("xflr5");
        break;
    }
  }
  return new Set(programs);
}

function scopedRelative(root: string, path: string): string | undefined {
  const value = relative(root, path);
  if (!value || value === ".") return value;
  if (value.startsWith("..") || value.split(sep).includes("..")) return undefined;
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid engineering workspace identifier.");
  return safe;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
