import { filterResearchMetadataTool } from "../planning/researchPlanner.js";
import { createStableId, nowIso } from "../shared/ids.js";
import { ResearchLoopStep, type ResearchPlan, type ResearchSnapshot, type ResearchSource, type RuntimeRequirement } from "../shared/types.js";
import { normalizeToolName } from "../tools/toolRunner.js";
import { concatItems } from "./executionBundles.js";
import { sameStringArray } from "./researchState.js";

const preOpenCodeToolOrder = ["websearchtool", "backgroundbrowsertool", "researchmetadatatool", "pdfingestiontool", "engineeringprogramtool"];

const preOpenCodeToolSet = new Set(preOpenCodeToolOrder);

export function preOpenCodeToolNames(plan: ResearchPlan | undefined): string[] {
  if (!plan?.requiredTools.length) return [];
  const requested = new Set<string>();
  for (const tool of plan.requiredTools) {
    const normalized = normalizeToolName(tool);
    if (preOpenCodeToolSet.has(normalized)) requested.add(normalized);
  }
  const output: string[] = [];
  for (const tool of preOpenCodeToolOrder) {
    if (requested.has(tool)) output.push(tool);
  }
  return output;
}

export function planForExecution(plan: ResearchPlan | undefined, snapshot: ResearchSnapshot): ResearchPlan | undefined {
  if (!plan) return undefined;
  const specification = snapshot.specifications.at(-1);
  if (!specification) return plan;
  const requiredTools = filterResearchMetadataTool(plan.requiredTools, {
    snapshot,
    specification,
    continuationDecision: snapshot.continuationDecisions.at(-1)
  });
  if (sameStringArray(requiredTools, plan.requiredTools)) return plan;
  return { ...plan, requiredTools };
}

export function planRequiresTool(plan: ResearchPlan | undefined, toolName: string): boolean {
  const normalizedTarget = normalizeToolName(toolName);
  for (const tool of plan?.requiredTools ?? []) {
    if (normalizeToolName(tool) === normalizedTarget) return true;
  }
  return false;
}

export function stepRequiresOpenCode(step: ResearchLoopStep, snapshot: ResearchSnapshot): boolean {
  return step === ResearchLoopStep.ExecuteTools && planRequiresTool(snapshot.researchPlans.at(-1), "OpenCodeTool");
}

export function collectExecutableToolNames(tools: string[], includeOpenCode: boolean): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  if (includeOpenCode) pushUniqueToolName(output, seen, "OpenCodeTool");
  for (const tool of tools) pushUniqueToolName(output, seen, tool);
  return output;
}

export function normalizedToolNameSet(tools: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const tool of tools) normalized.add(normalizeToolNameForPlan(tool));
  return normalized;
}

export function collectPlanToolRequirements(requiredTools: string[], registered: Set<string>, allowed: Set<string>): RuntimeRequirement[] {
  const missing: RuntimeRequirement[] = [];
  const unavailable: RuntimeRequirement[] = [];
  for (const tool of requiredTools) {
    const normalized = normalizeToolNameForPlan(tool);
    if (normalized === "opencodetool") continue;
    if (!registered.has(normalized)) {
      missing.push({
        key: "tool.registered",
        label: "Registered research tool",
        requiredForSteps: [ResearchLoopStep.PlanResearch],
        isSatisfied: false,
        message: `Research plan requires an unregistered tool: ${tool}`
      });
    }
    if (!allowed.has(normalized)) {
      unavailable.push({
        key: "tool.available",
        label: "Executable research tool",
        requiredForSteps: [ResearchLoopStep.PlanResearch],
        isSatisfied: false,
        message: `Research plan requires a tool that is not executable in the current settings/state: ${tool}`
      });
    }
  }
  return concatItems(missing, unavailable);
}

export function sourceCandidatesFromPlan(
  projectId: string,
  iteration: number,
  plan: ResearchPlan | undefined,
  context: ResearchSnapshot["projectContextSnapshots"][number] | undefined
): ResearchSource[] {
  const urls = new Map<string, string>();
  for (const url of plan?.fetchCandidateUrls ?? []) {
    const normalized = normalizePublicHttpUrl(url);
    if (normalized) urls.set(normalized, normalized);
  }
  const sources: ResearchSource[] = [];
  let index = 0;
  for (const url of urls.values()) {
    sources.push({
      id: createStableId("source", `${projectId}:${iteration}:fetch-candidate:${url}`),
      projectId,
      kind: "web",
      title: `Continuation fetch candidate ${index + 1}`,
      url,
      retrievedAt: nowIso(),
      metadata: {
        fromContinuationDecision: true,
        fromResearchPlan: plan?.id,
        fromProjectContextSnapshotId: context?.id,
        memoryScope: "project_only",
        sourceCandidateOnly: true,
        canSupportHypothesis: false
      },
      createdAt: nowIso()
    });
    index += 1;
  }
  return sources;
}

function pushUniqueToolName(output: string[], seen: Set<string>, tool: string): void {
  if (seen.has(tool)) return;
  seen.add(tool);
  output.push(tool);
}

function normalizePublicHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function normalizeToolNameForPlan(value: string): string {
  return value
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}
