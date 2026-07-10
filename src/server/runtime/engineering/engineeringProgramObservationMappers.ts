import { createId } from "../../../core/shared/ids.js";
import type { OpenCodeRunInput, ResearchArtifact, EvidenceItem } from "../../../core/shared/types.js";
import type {
  MeshSummary,
  ScriptedCfdRunSummary,
  Su2CaseRunSummary,
  XfoilPolarSummary,
  XfoilWasmPolarSummary
} from "../../../core/tools/engineeringProgramTypes.js";

export function meshSummaryArtifact(input: OpenCodeRunInput, summary: MeshSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.fileName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "generated_artifact",
    title: `Mesh inspection: ${summary.fileName}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/mesh-inspection-${safeName}.json`,
    mimeType: "application/json",
    summary: `Mesh ${summary.fileName}: ${summary.vertexCount} vertices, ${summary.triangleCount} triangles.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      canSupportHypothesis: false
    },
    createdAt
  };
}

export function xfoilPolarArtifact(input: OpenCodeRunInput, summary: XfoilPolarSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.airfoil.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL polar: ${summary.airfoil}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/xfoil-polar-${safeName}.json`,
    mimeType: "application/json",
    summary: `XFOIL polar for ${summary.airfoil}: ${summary.rowCount} alpha rows at Re=${summary.reynolds}, Mach=${summary.mach}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil",
      canSupportHypothesis: true
    },
    createdAt
  };
}

export function xfoilPolarEvidence(input: OpenCodeRunInput, summary: XfoilPolarSummary, createdAt: string): EvidenceItem {
  const previewRows = summary.rows.slice(0, 6).map((row) => `alpha=${row.alpha}, CL=${row.cl}, CD=${row.cd}`);
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL polar observation: ${summary.airfoil}`,
    summary: `Computed ${summary.rowCount} XFOIL polar rows for ${summary.airfoil}. ${previewRows.join("; ")}`,
    quote: previewRows.join("\n"),
    keywords: ["xfoil", "polar", "cfd", "aerodynamics", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.72,
    relevanceScore: 0.74,
    evidenceStrength: "medium",
    limitations: [
      "XFOIL is a low-order aerodynamic solver; check convergence, Reynolds/Mach assumptions, and airfoil geometry before using results for final decisions.",
      "AetherOps records the generated polar rows but does not replace engineering review."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil",
      airfoil: summary.airfoil,
      reynolds: summary.reynolds,
      mach: summary.mach,
      rowCount: summary.rowCount,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

export function xfoilWasmPolarArtifact(input: OpenCodeRunInput, summary: XfoilWasmPolarSummary, createdAt: string): ResearchArtifact {
  const safeName = summary.airfoil.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL-WASM polar: ${summary.airfoil}`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/xfoil-wasm-polar-${safeName}.json`,
    mimeType: "application/json",
    summary: `WebXFOIL polar for ${summary.airfoil}: ${summary.rowCount} alpha rows at Re=${summary.reynolds}, Mach=${summary.mach}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil-wasm",
      runtimeLicense: summary.runtimeLicense,
      canSupportHypothesis: true
    },
    createdAt
  };
}

export function xfoilWasmPolarEvidence(input: OpenCodeRunInput, summary: XfoilWasmPolarSummary, createdAt: string): EvidenceItem {
  const previewRows = summary.rows.slice(0, 6).map((row) => `alpha=${row.alpha}, CL=${row.cl}, CD=${row.cd}`);
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `XFOIL-WASM polar observation: ${summary.airfoil}`,
    summary: `Computed ${summary.rowCount} WebXFOIL polar rows for ${summary.airfoil}. ${previewRows.join("; ")}`,
    quote: previewRows.join("\n"),
    keywords: ["xfoil", "wasm", "polar", "cfd", "aerodynamics", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.76,
    relevanceScore: 0.8,
    evidenceStrength: "medium",
    limitations: [
      "WebXFOIL runs the open-source XFOIL solver compiled to WebAssembly; results still depend on XFOIL convergence, Reynolds/Mach assumptions, and input airfoil geometry.",
      "This is a 2D airfoil solver, not an SU2 field CFD solve.",
      `Runtime license recorded by AetherOps: ${summary.runtimeLicense}.`
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "xfoil-wasm",
      runtime: summary.runtime,
      runtimeVersion: summary.runtimeVersion,
      runtimeLicense: summary.runtimeLicense,
      airfoil: summary.airfoil,
      sourceKind: summary.sourceKind,
      sourceUrl: summary.sourceUrl,
      sourceArtifactPath: summary.sourceArtifactPath,
      reynolds: summary.reynolds,
      mach: summary.mach,
      rowCount: summary.rowCount,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

export function su2CaseRunArtifact(input: OpenCodeRunInput, summary: Su2CaseRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `su2-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "SU2 case run",
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `SU2-compatible command completed with exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "su2",
      canSupportHypothesis: true
    },
    createdAt
  };
}

export function scriptedCfdRunArtifact(input: OpenCodeRunInput, summary: ScriptedCfdRunSummary, createdAt: string): ResearchArtifact {
  const safeName = `${summary.target}-${summary.outputFileName}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  return {
    id: createId("artifact"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `${summary.label} CFD analysis run`,
    relativePath: `artifacts/iteration-${input.iteration}/engineering-program/${safeName}.json`,
    mimeType: "application/json",
    summary: `${summary.label} adapter completed with validated CFD spec and exitCode=${summary.exitCode}.`,
    content: `${JSON.stringify(summary, null, 2)}\n`,
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: summary.target,
      canSupportHypothesis: true
    },
    createdAt
  };
}

export function scriptedCfdRunEvidence(input: OpenCodeRunInput, summary: ScriptedCfdRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: `${summary.label} CFD tool observation`,
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || `${summary.label} adapter completed without captured output text.`,
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: [summary.target, "cfd", "aerodynamics", "validated_cfd_spec", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.74,
    evidenceStrength: "medium",
    limitations: [
      `${summary.label} results depend on the locally configured command, adapter script, validated cfdRunSpec, and solver convergence behavior.`,
      "AetherOps records the run, generated spec, and captured output but does not independently certify CFD convergence."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: summary.target,
      command: summary.command,
      scriptPath: summary.scriptPath,
      cfdRunSpec: summary.cfdRunSpec,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}

export function su2CaseRunEvidence(input: OpenCodeRunInput, summary: Su2CaseRunSummary, createdAt: string): EvidenceItem {
  return {
    id: createId("evidence"),
    projectId: input.project.id,
    category: "experiment_log",
    title: "SU2 tool observation",
    summary: summary.outputTextExcerpt || summary.stdoutExcerpt || "SU2-compatible command completed without captured output text.",
    quote: summary.outputTextExcerpt || summary.stdoutExcerpt,
    keywords: ["su2", "cfd", "case_run", "tool_observation"],
    linkedHypothesisIds: input.hypotheses.map((hypothesis) => hypothesis.id),
    reliabilityScore: 0.7,
    relevanceScore: 0.72,
    evidenceStrength: "medium",
    limitations: [
      "SU2 results depend on the locally configured solver command, case config, mesh, numerical settings, and convergence behavior.",
      "AetherOps records the run and captured output but does not independently validate CFD convergence."
    ],
    metadata: {
      traceabilityKind: "tool_observation",
      generatedBy: "EngineeringProgramTool",
      program: "su2",
      command: summary.command,
      caseRoot: summary.caseRoot,
      configPath: summary.configPath,
      cfdRunSpec: summary.cfdRunSpec,
      exitCode: summary.exitCode,
      canSupportHypothesis: true,
      sourceQualityTier: "tool_observation"
    },
    createdAt
  };
}
