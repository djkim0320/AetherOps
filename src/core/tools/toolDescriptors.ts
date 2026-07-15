import { z, type ZodType } from "zod";
import type { CapabilityKind } from "../domain/capabilities/types.js";
import { isNacaSeries, normalizeNacaSeries } from "./airfoilIdentity.js";
import type { AerospaceToolMetadata } from "./aerospaceToolMetadata.js";
import { normalizeToolName, orderToolNames } from "./toolMerger.js";
import type { ToolPhase } from "./researchToolTypes.js";

export type { AerospaceToolMetadata } from "./aerospaceToolMetadata.js";
export type { ToolPhase } from "./researchToolTypes.js";
export type ToolSideEffect = "network" | "filesystem" | "process";

export interface ToolDescriptor {
  name: string;
  version: string;
  phase: ToolPhase;
  requiredCapabilities: CapabilityKind[];
  inputSchema: ZodType<Record<string, unknown>>;
  dependencies: string[];
  sideEffects: ToolSideEffect[];
  exclusiveKey?: string;
  repeatable: boolean;
  description: string;
  aerospace?: AerospaceToolMetadata;
}

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "Only valid HTTP(S) URLs are supported.");
const shortText = z.string().trim().min(1).max(2_000);
const projectRelativePath = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value), "Path must be project-relative.")
  .refine((value) => !value.split(/[\\/]+/).includes(".."), "Parent path traversal is not allowed.");
const nacaSeriesSchema = z.string().trim().max(40).refine(isNacaSeries, "A 4 or 5 digit NACA series is required.").transform(normalizeNacaSeries);

const cfdRunSpecSchema = z
  .object({
    target: z.enum(["xfoil", "xfoil-wasm", "su2", "openvsp", "xflr5"]),
    geometry: z
      .object({
        source: z.enum(["artifact", "sourceUrl", "naca", "configuredCase"]),
        artifactPath: z.string().trim().min(1).max(1_000).optional(),
        sourceUrl: urlSchema.optional(),
        naca: nacaSeriesSchema.optional(),
        configuredCaseId: z.string().trim().min(1).max(200).optional(),
        coordinateBindingId: z.string().trim().min(1).max(300).optional(),
        description: shortText.optional()
      })
      .strict()
      .superRefine((geometry, context) => {
        if (geometry.source === "configuredCase" && !geometry.configuredCaseId) {
          context.addIssue({ code: "custom", message: "configuredCaseId is required for configuredCase geometry." });
        }
        if (geometry.source === "artifact" && !geometry.artifactPath) context.addIssue({ code: "custom", message: "artifactPath is required." });
        if (geometry.source === "sourceUrl" && !geometry.sourceUrl) context.addIssue({ code: "custom", message: "sourceUrl is required." });
        if (geometry.source === "naca" && !geometry.naca) context.addIssue({ code: "custom", message: "naca is required." });
      }),
    flightCondition: z
      .object({
        reynolds: z.number().positive().finite().optional(),
        mach: z.number().min(0).max(5).finite().optional(),
        alphaStart: z.number().finite().optional(),
        alphaEnd: z.number().finite().optional(),
        alphaStep: z.number().positive().finite().optional(),
        velocity: z.number().positive().finite().optional(),
        density: z.number().positive().finite().optional(),
        viscosity: z.number().positive().finite().optional()
      })
      .strict(),
    mesh: z
      .object({
        strategy: z.enum(["existing", "toolGenerated", "caseGenerated"]),
        artifactPath: z.string().trim().min(1).max(1_000).optional(),
        maxCells: z.number().int().positive().finite().optional(),
        boundaryLayer: z.boolean().optional(),
        yPlusTarget: z.number().nonnegative().finite().optional(),
        notes: shortText.optional()
      })
      .strict()
      .optional(),
    solver: z
      .object({
        name: z.enum(["xfoil", "webxfoil-wasm", "su2", "openvsp-vspaero", "xflr5"]),
        model: z.enum(["inviscid", "euler", "rans", "panel", "viscous-panel"]).optional(),
        turbulenceModel: z.enum(["sa", "sst", "kepsilon", "none"]).optional(),
        maxIterations: z.number().int().positive().finite().optional(),
        convergenceTolerance: z.number().positive().finite().optional()
      })
      .strict(),
    output: z
      .object({
        forceCoefficients: z.boolean().optional(),
        polar: z.boolean().optional(),
        pressureField: z.boolean().optional(),
        mesh: z.boolean().optional()
      })
      .strict()
      .optional(),
    rationale: shortText.optional()
  })
  .strict()
  .superRefine((spec, context) => {
    const expectedSolver = {
      xfoil: "xfoil",
      "xfoil-wasm": "webxfoil-wasm",
      su2: "su2",
      openvsp: "openvsp-vspaero",
      xflr5: "xflr5"
    }[spec.target];
    if (spec.solver.name !== expectedSolver)
      context.addIssue({ code: "custom", message: `solver ${spec.solver.name} is incompatible with target ${spec.target}.` });
  });

const engineeringProgramRequestSchema = z
  .object({
    kind: z.enum(["toolchain-check", "mesh-inspect", "xfoil-polar", "xfoil-wasm-polar", "su2-case-run", "openvsp-analysis-run", "xflr5-analysis-run"]),
    target: z.enum(["all", "xfoil", "xfoil-wasm", "modeling", "su2", "openvsp", "xflr5"]).optional(),
    cfdRunSpec: cfdRunSpecSchema.optional(),
    artifactPath: z.string().trim().min(1).max(1_000).optional(),
    sourceUrl: urlSchema.optional(),
    coordinateBindingId: z.string().trim().min(1).max(300).optional(),
    outputFileName: z.string().trim().min(1).max(240).optional(),
    naca: nacaSeriesSchema.optional(),
    reynolds: z.number().positive().finite().optional(),
    mach: z.number().min(0).max(5).finite().optional(),
    alphaStart: z.number().finite().optional(),
    alphaEnd: z.number().finite().optional(),
    alphaStep: z.number().positive().finite().optional(),
    transition: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("free") }).strict(),
        z
          .object({
            mode: z.literal("forced"),
            upperXOverC: z.number().min(0).max(1).finite(),
            lowerXOverC: z.number().min(0).max(1).finite(),
            sourceEvidenceId: z.string().trim().min(1).max(300)
          })
          .strict()
      ])
      .optional(),
    reason: shortText.optional()
  })
  .strict()
  .superRefine((request, context) => {
    const expectedTarget: Record<string, string> = {
      "mesh-inspect": "modeling",
      "xfoil-polar": "xfoil",
      "xfoil-wasm-polar": "xfoil-wasm",
      "su2-case-run": "su2",
      "openvsp-analysis-run": "openvsp",
      "xflr5-analysis-run": "xflr5"
    };
    const expected = expectedTarget[request.kind];
    if (expected && request.target !== expected) context.addIssue({ code: "custom", message: `${request.kind} requires target=${expected}.` });
  });

const builtinDescriptors: ToolDescriptor[] = [
  descriptor(
    "WebSearchTool",
    "acquisition.discovery",
    ["search"],
    z.object({ query: shortText }).strict(),
    [],
    ["network"],
    true,
    "Discover public sources for a focused query."
  ),
  descriptor(
    "BackgroundBrowserTool",
    "acquisition.discovery",
    ["search"],
    z
      .object({ query: shortText.optional(), urls: z.array(urlSchema).min(1).max(8).optional() })
      .strict()
      .refine((value) => Boolean(value.query || value.urls?.length), "query or urls is required."),
    [],
    ["network", "process"],
    true,
    "Navigate explicitly scoped public pages or perform allowed discovery."
  ),
  descriptor(
    "WebFetchTool",
    "acquisition.fetch",
    ["search"],
    z.object({ urls: z.array(urlSchema).min(1).max(8) }).strict(),
    [],
    ["network"],
    true,
    "Fetch explicitly selected public URLs."
  ),
  descriptor(
    "ResearchMetadataTool",
    "acquisition.discovery",
    ["search"],
    z.object({ query: shortText }).strict(),
    [],
    ["network"],
    true,
    "Retrieve scholarly publication and citation metadata."
  ),
  descriptor(
    "PdfIngestionTool",
    "acquisition.fetch",
    ["search"],
    z.object({ urls: z.array(urlSchema).min(1).max(8) }).strict(),
    ["WebFetchTool"],
    ["network", "filesystem"],
    true,
    "Extract text and metadata from selected PDF sources."
  ),
  descriptor(
    "EngineeringProgramTool",
    "exclusive",
    ["engineering"],
    z.object({ programRequests: z.array(engineeringProgramRequestSchema).min(1).max(4) }).strict(),
    [],
    ["filesystem", "process"],
    "project-engineering",
    false,
    "Execute validated engineering program requests using an explicitly selected target.",
    {
      discipline: "aerodynamics",
      fidelity: 2,
      intendedUses: ["airfoil polar", "public aerodynamic validation", "research mesh inspection"],
      validInputEnvelope: "Explicit solver-specific envelope and configuration baseline are required.",
      quantityKinds: ["Mach", "Reynolds", "angle", "force coefficient"],
      frameKinds: ["wind", "body"],
      deterministic: true,
      solverRequirements: ["explicit installed or bundled adapter"],
      licenseRequirement: "user_supplied",
      resourceBudget: { cpuSeconds: 600, memoryBytes: 2_147_483_648, diskBytes: 1_073_741_824, wallClockMs: 900_000 },
      inputArtifactTypes: ["airfoil_coordinates", "mesh", "solver_case"],
      outputArtifactTypes: ["polar", "mesh_report", "solver_result"],
      preconditions: ["units_valid", "frames_valid", "baseline_current", "model_use_accepted"],
      postconditions: ["output_hash_verified", "solver_status_terminal", "convergence_assessed"],
      verificationStrategy: "Adapter-specific parser, postcondition and reproducibility receipt.",
      supportsUncertainty: false,
      supportsSensitivity: false,
      qualificationStatus: "unqualified_research",
      externalSideEffectRisk: "bounded_compute",
      schemaByteEstimate: 9_000
    }
  ),
  descriptor(
    "CodexCliTool",
    "exclusive",
    ["agent", "engineering"],
    z
      .object({
        task: shortText,
        inputArtifactIds: z.array(z.string().trim().min(1).max(300)).max(32),
        outputs: z
          .array(z.object({ relativePath: projectRelativePath, kind: z.enum(["code", "report", "data"]) }).strict())
          .min(1)
          .max(8)
      })
      .strict(),
    [],
    ["filesystem", "process"],
    "project-engineering",
    false,
    "Perform an explicitly authorized, offline Codex CLI task in an isolated staging workspace."
  ),
  descriptor(
    "DataAnalysisTool",
    "analysis",
    [],
    z
      .object({
        checks: z
          .array(z.enum(["source_scope", "evidence_coverage", "question_coverage", "hypothesis_coverage", "engineering_fidelity", "artifact_completeness"]))
          .min(1)
          .max(6)
          .refine((values) => new Set(values).size === values.length, "Analysis checks must be unique.")
      })
      .strict(),
    [],
    [],
    false,
    "Deterministically validate collected outputs, provenance, coverage, and engineering fidelity."
  ),
  descriptor(
    "ArtifactWriterTool",
    "artifact",
    [],
    z
      .object({
        artifacts: z
          .array(
            z
              .object({
                relativePath: projectRelativePath,
                kind: z.enum(["research_report", "evidence_index", "hypothesis_assessment", "plan_revision_hints", "source_inventory", "engineering_result"]),
                format: z.enum(["markdown", "json"])
              })
              .strict()
              .superRefine((artifact, context) => {
                const expected = artifact.format === "json" ? ".json" : ".md";
                if (!artifact.relativePath.toLowerCase().endsWith(expected)) {
                  context.addIssue({ code: "custom", path: ["relativePath"], message: `${artifact.format} artifacts require ${expected}.` });
                }
              })
          )
          .min(1)
          .max(8)
          .refine((items) => new Set(items.map((item) => item.relativePath.toLowerCase())).size === items.length, "Artifact paths must be unique.")
      })
      .strict(),
    ["DataAnalysisTool"],
    ["filesystem"],
    false,
    "Write the requested research artifacts after analysis."
  )
];

const descriptorsByName = new Map(builtinDescriptors.map((item) => [normalizeToolName(item.name), item]));

export function listToolDescriptors(): ToolDescriptor[] {
  return [...builtinDescriptors];
}

export function getToolDescriptor(name: string): ToolDescriptor | undefined {
  return descriptorsByName.get(normalizeToolName(name));
}

export function getToolDescriptorOrCustom(name: string): ToolDescriptor {
  return getToolDescriptor(name) ?? customDescriptor(name);
}

export function plannerToolDescriptors(availableTools: string[], options: { allowCodexCli: boolean }): ToolDescriptor[] {
  const descriptors: ToolDescriptor[] = [];
  for (const name of orderToolNames(availableTools)) {
    if (!options.allowCodexCli && normalizeToolName(name) === "codexclitool") continue;
    descriptors.push(getToolDescriptor(name) ?? customDescriptor(name));
  }
  return descriptors;
}

function descriptor(
  name: string,
  phase: ToolPhase,
  requiredCapabilities: CapabilityKind[],
  inputSchema: ZodType<Record<string, unknown>>,
  dependencies: string[],
  sideEffects: ToolSideEffect[],
  repeatableOrExclusive: boolean | string,
  repeatableOrDescription: boolean | string,
  description?: string,
  aerospace?: AerospaceToolMetadata
): ToolDescriptor {
  const exclusiveKey = typeof repeatableOrExclusive === "string" ? repeatableOrExclusive : undefined;
  const repeatable = typeof repeatableOrExclusive === "boolean" ? repeatableOrExclusive : (repeatableOrDescription as boolean);
  const resolvedDescription = (typeof repeatableOrDescription === "string" ? repeatableOrDescription : description) ?? "";
  return {
    name,
    version: "1",
    phase,
    requiredCapabilities,
    inputSchema,
    dependencies,
    sideEffects,
    ...(exclusiveKey ? { exclusiveKey } : {}),
    repeatable,
    description: resolvedDescription,
    ...(aerospace ? { aerospace } : {})
  };
}

function customDescriptor(name: string): ToolDescriptor {
  return {
    name,
    version: "1",
    phase: "analysis",
    requiredCapabilities: [],
    inputSchema: z.record(z.string(), z.unknown()),
    dependencies: [],
    sideEffects: [],
    repeatable: false,
    description: "Registered project-specific research tool."
  };
}
