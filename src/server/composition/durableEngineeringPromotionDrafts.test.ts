import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import type { ResearchToolResult } from "../../core/tools/researchToolTypes.js";
import { REQUIRED_CODEX_CLI_VERSION } from "../runtime/codex/bundledCodexCli.js";
import { WEBXFOIL_GEOMETRY_RECEIPT_VERSION } from "../runtime/engineering/engineeringProgramCoordinateResolver.js";
import { BUNDLED_WEBXFOIL_RUNTIME, BUNDLED_WEBXFOIL_VERSION } from "../runtime/engineering/engineeringRuntimeVersions.js";
import { createWebXfoilPolarResultReceipt } from "../runtime/engineering/webXfoilPolarResultReceipt.js";
import { configurationBaselineContentHash } from "../runtime/storage/v2/engineeringBaselineIntegrity.js";
import { buildDurableEngineeringPromotionDrafts, engineeringPromotionDraftKey } from "./durableEngineeringPromotionDrafts.js";

const GEOMETRY_HASH = "99324fe31b74dcfaf49e011b6382adb9884fdb5945bfdac2414fb25c89a22593";
const OTHER_GEOMETRY_HASH = "b".repeat(64);
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("durable engineering promotion drafts", () => {
  it("fails closed when an engineering output omits its program identity", () => {
    expect(() => build([artifactResult(undefined)], baseline({ "xfoil-wasm": "0.1.1" }))).toThrow(/program identity/i);
  });

  it("validates every draft before materializing any CAS bytes", () => {
    const result = artifactResult("xfoil-wasm");
    result.artifacts.push({
      ...result.artifacts[0]!,
      id: "artifact-invalid-second",
      metadata: { originToolAttemptId: "execution-1:action-1" }
    });

    expect(() => build([result], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }))).toThrow(/program identity/i);
    expect(existsSync(join(root!, "migration", "v2", "terminal-cas"))).toBe(false);
  });

  it("fails closed instead of inventing an unrecorded solver version", () => {
    expect(() => build([artifactResult("xfoil-wasm")], baseline({}))).toThrow(/solver version/i);
  });

  it("uses the verified WebXFOIL runtime version only after an exact baseline match", () => {
    const canonical = firstDraft(build([artifactResult("xfoil-wasm")], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION })));
    const alias = firstDraft(build([artifactResult("xfoil-wasm")], baseline({ webxfoil: BUNDLED_WEBXFOIL_VERSION })));

    expect(canonical.executionMedia).toBe(`xfoil-wasm@${BUNDLED_WEBXFOIL_VERSION}`);
    expect(alias.executionMedia).toBe(`xfoil-wasm@${BUNDLED_WEBXFOIL_VERSION}`);
  });

  it("promotes WebXFOIL artifact and evidence as the same airfoil-bound polar", () => {
    const result = artifactResult("xfoil-wasm");
    result.evidence.push(webXfoilEvidence());
    const prepared = build([result], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }));

    expect([...prepared.drafts.values()]).toHaveLength(2);
    for (const draft of prepared.drafts.values()) {
      expect(draft).toMatchObject({
        resultKind: "polar",
        geometryHash: GEOMETRY_HASH,
        convergence: "converged",
        domainAssessment: "verified",
        dependencyAspects: expect.arrayContaining(["geometry", "airfoil_geometry", "aerodynamic_reference"])
      });
    }
  });

  it("matches evidence to its exact polar result instead of the first same-geometry case", () => {
    const result = artifactResult("xfoil-wasm");
    const failed = webXfoilSummary(true);
    const successful = webXfoilSummary();
    result.toolRun.output = {
      outputs: [
        { kind: "xfoil-wasm-polar", target: "xfoil-wasm", summary: failed },
        { kind: "xfoil-wasm-polar", target: "xfoil-wasm", summary: successful }
      ]
    };
    result.evidence.push(webXfoilEvidence());

    const prepared = build([result], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }));
    expect([...prepared.drafts.values()].every((draft) => draft.convergence === "converged" && draft.domainAssessment === "verified")).toBe(true);
  });

  it("rejects an ambiguous duplicate polar result receipt", () => {
    const result = artifactResult("xfoil-wasm");
    const summary = webXfoilSummary();
    result.toolRun.output = {
      outputs: [
        { kind: "xfoil-wasm-polar", target: "xfoil-wasm", summary },
        { kind: "xfoil-wasm-polar", target: "xfoil-wasm", summary }
      ]
    };
    expect(() => build([result], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }))).toThrow(/ambiguous/i);
  });

  it("requires each polar receipt to pair with exactly one full artifact", () => {
    const result = artifactResult("xfoil-wasm");
    result.artifacts.push({ ...result.artifacts[0]!, id: "artifact-duplicate-polar" });

    expect(() => build([result], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }))).toThrow(/multiple paired full artifacts/i);
    expect(existsSync(join(root!, "migration", "v2", "terminal-cas"))).toBe(false);
  });

  it("recomputes the receipt from the full paired artifact before materializing CAS bytes", () => {
    const result = artifactResult("xfoil-wasm");
    const content = JSON.parse(result.artifacts[0]!.content!) as { rows: Array<{ cl: number }> };
    content.rows[0]!.cl = 0.25;
    result.artifacts[0]!.content = JSON.stringify(content);

    expect(() => build([result], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }))).toThrow(/full result content/i);
    expect(existsSync(join(root!, "migration", "v2", "terminal-cas"))).toBe(false);
  });

  it("rejects geometry receipt or active-airfoil mismatch before materializing CAS bytes", () => {
    const receiptMismatch = artifactResult("xfoil-wasm");
    receiptMismatch.artifacts[0]!.metadata = { ...receiptMismatch.artifacts[0]!.metadata, geometryContentHash: OTHER_GEOMETRY_HASH };
    expect(() => build([receiptMismatch], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }))).toThrow(/receipt/i);
    expect(existsSync(join(root!, "migration", "v2", "terminal-cas"))).toBe(false);

    const baselineMismatch = baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION });
    baselineMismatch.airfoilGeometryHash = OTHER_GEOMETRY_HASH;
    baselineMismatch.contentHash = configurationBaselineContentHash(baselineMismatch);
    expect(() => build([artifactResult("xfoil-wasm")], baselineMismatch)).toThrow(/active baseline airfoil geometry/i);
    expect(existsSync(join(root!, "migration", "v2", "terminal-cas"))).toBe(false);
  });

  it("binds pending CAS claims to the durable output-link attempt identity", () => {
    const prepared = build([artifactResult("xfoil-wasm")], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }));

    expect(prepared.casClaims).toEqual([
      expect.objectContaining({
        owner: expect.objectContaining({
          projectId: "project-1",
          jobId: "job-1",
          attemptId: "attempt-durable-execution-1:action-1",
          outputKind: "artifact",
          outputId: "artifact-1"
        })
      })
    ]);
    expect(prepared.casClaims[0]?.owner.attemptId).not.toBe("execution-1:action-1");
  });

  it("rejects runtime mismatch, missing receipts, and conflicting WebXFOIL aliases", () => {
    expect(() => build([artifactResult("xfoil-wasm")], baseline({ "xfoil-wasm": "0.1.0" }))).toThrow(/does not match baseline/i);

    const missing = artifactResult("xfoil-wasm");
    delete missing.artifacts[0]!.metadata!.runtimeVersion;
    expect(() => build([missing], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION }))).toThrow(/runtime version receipt/i);

    expect(() => build([artifactResult("xfoil-wasm")], baseline({ "xfoil-wasm": BUNDLED_WEBXFOIL_VERSION, webxfoil: "0.1.0" }))).toThrow(
      /conflicting solver version aliases/i
    );
  });

  it("accepts only the exact locked Codex CLI version receipt", () => {
    const accepted = firstDraft(build([codexArtifactResult(REQUIRED_CODEX_CLI_VERSION)], baseline({ codex: REQUIRED_CODEX_CLI_VERSION })));
    expect(accepted.executionMedia).toBe(`codex@${REQUIRED_CODEX_CLI_VERSION}`);

    expect(() => build([codexArtifactResult(REQUIRED_CODEX_CLI_VERSION)], baseline({ codex: "0.143.0" }))).toThrow(/does not match baseline/i);
    expect(() => build([codexArtifactResult("0.143.0")], baseline({ codex: "0.143.0" }))).toThrow(/not produced by bundled Codex CLI/i);

    const missing = codexArtifactResult(REQUIRED_CODEX_CLI_VERSION);
    const trace = (missing.toolRun.output as { codexCliTrace: Record<string, unknown> }).codexCliTrace;
    delete trace.cliVersion;
    expect(() => build([missing], baseline({ codex: REQUIRED_CODEX_CLI_VERSION }))).toThrow(/runtime version receipt/i);
  });

  it("does not substitute a baseline geometry hash for a native polar input receipt", () => {
    expect(() => build([nativeXfoilArtifactResult()], baseline({ xfoil: "6.99" }))).toThrow(/measured airfoil geometry receipt/i);
    expect(existsSync(join(root!, "migration", "v2", "terminal-cas"))).toBe(false);
  });

  it("rejects cross-project, cross-attempt, and unrequested program outputs", () => {
    const crossProject = artifactResult("xfoil-wasm");
    crossProject.artifacts[0]!.projectId = "another-project";
    expect(() => build([crossProject], baseline({ "xfoil-wasm": "0.1.1" }))).toThrow(/originating project attempt/i);

    const crossAttempt = artifactResult("xfoil-wasm");
    crossAttempt.artifacts[0]!.metadata = { ...crossAttempt.artifacts[0]!.metadata, originToolAttemptId: "execution-1:another-action" };
    expect(() => build([crossAttempt], baseline({ "xfoil-wasm": "0.1.1" }))).toThrow(/originating project attempt/i);

    const unrequested = artifactResult("su2");
    expect(() => build([unrequested], baseline({ su2: "8.2.0" }))).toThrow(/not authorized/i);
  });
});

function build(results: ResearchToolResult[], value: ConfigurationBaseline) {
  root = mkdtempSync(join(tmpdir(), "aetherops-engineering-draft-"));
  const claimOwners = new Map<string, { projectId: string; jobId: string; attemptId: string; outputKind: "artifact" | "evidence"; outputId: string }>();
  for (const result of results) {
    const originAttemptId = result.toolRun.originAttemptId;
    if (!originAttemptId) continue;
    for (const artifact of result.artifacts) {
      claimOwners.set(engineeringPromotionDraftKey(originAttemptId, "artifact", artifact.id), {
        projectId: value.projectId,
        jobId: "job-1",
        attemptId: `attempt-durable-${originAttemptId}`,
        outputKind: "artifact",
        outputId: artifact.id
      });
    }
    for (const evidence of result.evidence) {
      claimOwners.set(engineeringPromotionDraftKey(originAttemptId, "evidence", evidence.id), {
        projectId: value.projectId,
        jobId: "job-1",
        attemptId: `attempt-durable-${originAttemptId}`,
        outputKind: "evidence",
        outputId: evidence.id
      });
    }
  }
  return buildDurableEngineeringPromotionDrafts({
    results,
    baseline: value,
    dataRoot: root,
    jobId: "job-1",
    executionId: "execution-1",
    claimOwners
  });
}

function artifactResult(program: string | undefined): ResearchToolResult {
  const createdAt = "2026-07-16T00:00:00.000Z";
  const summary = webXfoilSummary();
  return {
    toolRun: {
      id: "tool-run-1",
      projectId: "project-1",
      iteration: 1,
      toolName: "EngineeringProgramTool",
      input: { requests: [{ kind: "xfoil-wasm-polar" }] },
      output: {
        outputs: [
          {
            kind: "xfoil-wasm-polar",
            target: "xfoil-wasm",
            summary
          }
        ]
      },
      status: "completed",
      originAttemptId: "execution-1:action-1",
      startedAt: createdAt,
      completedAt: createdAt
    },
    sources: [],
    evidence: [],
    artifacts: [
      {
        id: "artifact-1",
        projectId: "project-1",
        category: "generated_artifact",
        title: "Engineering output",
        relativePath: "result.json",
        mimeType: "application/json",
        summary: "Test output",
        content: JSON.stringify(summary),
        metadata: {
          ...(program ? { program } : {}),
          ...(program === "xfoil-wasm"
            ? {
                runtime: BUNDLED_WEBXFOIL_RUNTIME,
                runtimeVersion: BUNDLED_WEBXFOIL_VERSION,
                geometryContentHash: GEOMETRY_HASH,
                geometryPointCount: 240,
                geometryReceiptVersion: WEBXFOIL_GEOMETRY_RECEIPT_VERSION,
                polarResultHash: summary.polarResultHash,
                polarResultReceiptVersion: summary.polarResultReceiptVersion
              }
            : {}),
          originToolAttemptId: "execution-1:action-1"
        },
        createdAt
      }
    ]
  };
}

function webXfoilSummary(failed = false): Record<string, unknown> {
  const rows = [{ alpha: 0, cl: 0.1, cd: 0.01, cm: -0.02 }];
  const convergence = { hasNaN: false, hasFortranError: false, hasConvergenceFail: failed };
  const request = {
    reynolds: failed ? 2_000_000 : 1_000_000,
    mach: 0,
    alphaStart: 0,
    alphaEnd: 0,
    alphaStep: 1,
    transition: "free" as const
  };
  const receipt = createWebXfoilPolarResultReceipt({
    runtimeVersion: BUNDLED_WEBXFOIL_VERSION,
    geometry: { contentHash: GEOMETRY_HASH, pointCount: 240, version: WEBXFOIL_GEOMETRY_RECEIPT_VERSION },
    request,
    rows,
    convergence
  });
  return {
    runtime: BUNDLED_WEBXFOIL_RUNTIME,
    runtimeVersion: BUNDLED_WEBXFOIL_VERSION,
    geometryContentHash: GEOMETRY_HASH,
    geometryPointCount: 240,
    geometryReceiptVersion: WEBXFOIL_GEOMETRY_RECEIPT_VERSION,
    polarResultHash: receipt.contentHash,
    polarResultReceiptVersion: receipt.version,
    ...request,
    rows,
    convergence
  };
}

function webXfoilEvidence() {
  const summary = webXfoilSummary();
  return {
    id: "evidence-1",
    projectId: "project-1",
    category: "experiment_log" as const,
    title: "WebXFOIL polar evidence",
    summary: "A verified polar observation.",
    keywords: ["webxfoil", "polar"],
    linkedHypothesisIds: [],
    reliabilityScore: 0.8,
    relevanceScore: 0.8,
    evidenceStrength: "strong" as const,
    limitations: [],
    metadata: {
      program: "xfoil-wasm",
      runtime: BUNDLED_WEBXFOIL_RUNTIME,
      runtimeVersion: BUNDLED_WEBXFOIL_VERSION,
      geometryContentHash: GEOMETRY_HASH,
      geometryPointCount: 240,
      geometryReceiptVersion: WEBXFOIL_GEOMETRY_RECEIPT_VERSION,
      polarResultHash: summary.polarResultHash,
      polarResultReceiptVersion: summary.polarResultReceiptVersion,
      originToolAttemptId: "execution-1:action-1"
    },
    createdAt: "2026-07-16T00:00:00.000Z"
  };
}

function codexArtifactResult(cliVersion: string): ResearchToolResult {
  const createdAt = "2026-07-16T00:00:00.000Z";
  const trace = {
    cliVersion,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    sandboxProfile: "aetherops-codex-workspace-v1" as const,
    networkPolicy: "disabled" as const,
    durationMs: 1,
    exitCode: 0,
    eventCount: 1,
    workspaceManifestHash: "a".repeat(64),
    outputManifestHash: "b".repeat(64),
    terminationReason: "completed"
  };
  return {
    toolRun: {
      id: "tool-run-codex",
      projectId: "project-1",
      iteration: 1,
      toolName: "CodexCliTool",
      input: { task: "Produce a report.", inputArtifactIds: [], outputs: [{ relativePath: "result.json", kind: "report" }] },
      output: { codexCliTrace: trace },
      status: "completed",
      originAttemptId: "execution-1:action-codex",
      startedAt: createdAt,
      completedAt: createdAt
    },
    sources: [],
    evidence: [],
    artifacts: [
      {
        id: "artifact-codex",
        projectId: "project-1",
        category: "generated_artifact",
        title: "Codex output",
        relativePath: "result.json",
        mimeType: "application/json",
        summary: "Test output",
        content: "{}",
        metadata: { originToolAttemptId: "execution-1:action-codex", codexCliTrace: trace },
        createdAt
      }
    ]
  };
}

function nativeXfoilArtifactResult(): ResearchToolResult {
  const result = artifactResult("xfoil");
  result.toolRun.input = { requests: [{ kind: "xfoil-polar" }] };
  result.toolRun.output = { outputs: [{ kind: "xfoil-polar", target: "xfoil", summary: {} }] };
  return result;
}

function firstDraft(result: ReturnType<typeof build>) {
  const draft = result.drafts.values().next().value;
  if (!draft) throw new Error("Expected an engineering promotion draft.");
  return draft;
}

function baseline(solverVersions: Record<string, string>): ConfigurationBaseline {
  const value: ConfigurationBaseline = {
    id: "baseline-1",
    projectId: "project-1",
    revision: 1,
    status: "active",
    geometryHash: GEOMETRY_HASH,
    airfoilGeometryHash: GEOMETRY_HASH,
    aerodynamicReference: {
      area: quantity(1, "m^2", 2),
      chord: quantity(1, "m", 1),
      span: quantity(1, "m", 1),
      momentReferencePointId: "quarter-chord",
      axisConventionId: "wind-axes-right-handed-v1",
      dynamicPressureDefinition: "q=0.5*rho*V^2"
    },
    unitConventionId: "si-v1",
    coordinateConventionId: "right-handed-cartesian-v1",
    solverVersions,
    materialRevisionIds: [],
    sourceRevisionIds: ["fixture:engineering-draft"],
    equationVersionIds: [],
    contentHash: "0".repeat(64),
    createdAt: "2026-07-16T00:00:00.000Z",
    createdBy: "engineering-draft-test",
    provenance: [{ id: "fixture:engineering-draft" }]
  };
  return { ...value, contentHash: configurationBaselineContentHash(value) };
}

function quantity(value: number, unit: string, lengthExponent: number) {
  return {
    kind: "scalar" as const,
    valueSI: value,
    dimension: { mass: 0, length: lengthExponent, time: 0, temperature: 0, current: 0, amount: 0, luminousIntensity: 0, angle: 0 },
    semantic: "generic" as const,
    originalValue: value,
    originalUnit: unit,
    displayUnit: unit,
    provenance: { sourceType: "user" as const, sourceId: "fixture:engineering-draft" },
    serializationVersion: 1 as const
  };
}
