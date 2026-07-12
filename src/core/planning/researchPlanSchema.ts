import { z } from "zod";
import type { ToolDescriptor } from "../tools/toolDescriptors.js";
import { evaluateSourceAccess, type SourceAccessPolicy } from "../tools/sourceAccessPolicy.js";
import { requestMatchesExplicitTarget, type ExplicitEngineeringTarget } from "./explicitEngineeringTargetPolicy.js";
import type { EngineeringProgramRequest } from "../shared/types.js";

const text = z.string().trim().min(1).max(4_000);
const textList = z.array(text).max(12);

export interface PlannerToolIntent {
  intentId: string;
  toolName: string;
  purpose: string;
  expectedOutcome: string;
  inputs: Record<string, unknown>;
}

export function createResearchPlanLlmOutputSchema(
  descriptors: ToolDescriptor[],
  sourcePolicy?: SourceAccessPolicy,
  explicitEngineeringTarget?: ExplicitEngineeringTarget,
  requiredToolNames: string[] = []
) {
  const toolIntentSchema = createPlannerToolIntentSchema(descriptors);
  const descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  return z
    .object({
      objective: text,
      targetQuestions: textList,
      targetHypotheses: textList,
      toolRequests: z.array(toolIntentSchema).min(1).max(12),
      expectedSources: textList,
      expectedArtifacts: textList,
      executionSteps: textList.min(1),
      stopCriteria: textList.min(1),
      fetchCandidateUrls: z
        .array(
          z
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
            }, "Only valid HTTP(S) URLs are supported.")
        )
        .max(8)
    })
    .strict()
    .superRefine((value, context) => {
      const intentIds = new Set<string>();
      const selectedToolNames = new Set<string>();
      const nonRepeatableTools = new Set<string>();
      let explicitTargetSelected = false;
      for (let index = 0; index < value.fetchCandidateUrls.length; index += 1) {
        addSourcePolicyIssue(sourcePolicy, value.fetchCandidateUrls[index], context, ["fetchCandidateUrls", index]);
      }
      for (let index = 0; index < value.toolRequests.length; index += 1) {
        const request = value.toolRequests[index];
        const descriptor = descriptorsByName.get(request.toolName);
        if (!descriptor) {
          context.addIssue({ code: "custom", path: ["toolRequests", index, "toolName"], message: `Tool is not available: ${request.toolName}` });
          continue;
        }
        selectedToolNames.add(descriptor.name);
        if (intentIds.has(request.intentId)) {
          context.addIssue({ code: "custom", path: ["toolRequests", index, "intentId"], message: "intentId must be unique." });
        }
        intentIds.add(request.intentId);
        if (!descriptor.repeatable && nonRepeatableTools.has(descriptor.name)) {
          context.addIssue({ code: "custom", path: ["toolRequests", index, "toolName"], message: `${descriptor.name} may only be selected once.` });
        }
        if (!descriptor.repeatable) nonRepeatableTools.add(descriptor.name);
        if (sourcePolicy?.mode === "allowlist" && (descriptor.name === "WebSearchTool" || descriptor.name === "ResearchMetadataTool")) {
          context.addIssue({
            code: "custom",
            path: ["toolRequests", index, "toolName"],
            message: `${descriptor.name} cannot perform broad discovery in allowlist mode.`
          });
        }
        if (sourcePolicy?.mode === "allowlist" && descriptor.name === "BackgroundBrowserTool" && "query" in request.inputs) {
          context.addIssue({
            code: "custom",
            path: ["toolRequests", index, "inputs", "query"],
            message: "BackgroundBrowserTool requires explicit URLs in allowlist mode."
          });
        }
        for (const [urlIndex, url] of collectInputUrls(request.inputs).entries()) {
          addSourcePolicyIssue(sourcePolicy, url, context, ["toolRequests", index, "inputs", "urls", urlIndex]);
        }
        const parsedInputs = descriptor.inputSchema.safeParse(request.inputs);
        if (!parsedInputs.success) {
          for (const issue of parsedInputs.error.issues) {
            context.addIssue({ code: "custom", path: ["toolRequests", index, "inputs", ...issue.path], message: issue.message });
          }
        }
        if (descriptor.name === "EngineeringProgramTool" && explicitEngineeringTarget) {
          const programRequests = Array.isArray(request.inputs.programRequests) ? request.inputs.programRequests : [];
          for (let requestIndex = 0; requestIndex < programRequests.length; requestIndex += 1) {
            const programRequest = programRequests[requestIndex];
            const target = programRequest && typeof programRequest === "object" ? (programRequest as { target?: unknown }).target : undefined;
            if (!requestMatchesExplicitTarget(programRequest as EngineeringProgramRequest, explicitEngineeringTarget)) {
              context.addIssue({
                code: "custom",
                path: ["toolRequests", index, "inputs", "programRequests", requestIndex, "target"],
                message: `The user explicitly required ${explicitEngineeringTarget}; target=${String(target)} is a forbidden solver substitution.`
              });
            } else {
              explicitTargetSelected = true;
            }
          }
        }
      }
      for (const requiredToolName of requiredToolNames) {
        if (!selectedToolNames.has(requiredToolName)) {
          context.addIssue({ code: "custom", path: ["toolRequests"], message: `${requiredToolName} is required by the explicit input resource type.` });
        }
      }
      if (explicitEngineeringTarget && !explicitTargetSelected) {
        context.addIssue({
          code: "custom",
          path: ["toolRequests"],
          message: `The user explicitly required ${explicitEngineeringTarget}; the plan must use only that engineering target or fail closed.`
        });
      }
    });
}

function createPlannerToolIntentSchema(descriptors: ToolDescriptor[]): z.ZodType<PlannerToolIntent> {
  if (!descriptors.length) throw new Error("The research planner requires at least one ready tool descriptor.");
  const available = new Set(descriptors.map((descriptor) => descriptor.name));
  const schemas = descriptors.map((descriptor) =>
    z
      .object({
        intentId: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
        toolName: z.literal(descriptor.name),
        purpose: z.string().trim().min(1).max(1_000),
        expectedOutcome: z.string().trim().min(1).max(1_000),
        inputs: descriptor.inputSchema
      })
      .strict()
  );
  const schema =
    schemas.length === 1
      ? (schemas[0] as z.ZodType<PlannerToolIntent>)
      : z.union(schemas as unknown as [z.ZodType<PlannerToolIntent>, z.ZodType<PlannerToolIntent>, ...z.ZodType<PlannerToolIntent>[]]);
  return z.preprocess((value) => {
    const toolName = value && typeof value === "object" && "toolName" in value ? (value as { toolName?: unknown }).toolName : undefined;
    if (typeof toolName === "string" && !available.has(toolName)) throw new Error(`Tool is not available: ${toolName}`);
    return value;
  }, schema) as z.ZodType<PlannerToolIntent>;
}

function addSourcePolicyIssue(policy: SourceAccessPolicy | undefined, url: string, context: z.RefinementCtx, path: Array<string | number>): void {
  if (!policy) return;
  const decision = evaluateSourceAccess(policy, url);
  if (!decision.allowed) context.addIssue({ code: "custom", path, message: decision.reason ?? "URL is denied by the job source policy." });
}

function collectInputUrls(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /(?:^|_)(?:url|sourceurl)$/i.test(key) && /^https?:\/\//i.test(value) ? [value] : [];
  if (Array.isArray(value))
    return /urls$/i.test(key) ? value.filter((item): item is string => typeof item === "string") : value.flatMap((item) => collectInputUrls(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([entryKey, entryValue]) => collectInputUrls(entryValue, entryKey));
}

export type ResearchPlanLlmOutput = z.infer<ReturnType<typeof createResearchPlanLlmOutputSchema>>;
