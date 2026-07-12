import { ResearchLoopStep, type ResearchPlan, type ResearchSnapshot, type RuntimeRequirement } from "../shared/types.js";
import { normalizeToolName } from "../tools/toolRunner.js";
import { concatItems } from "./executionBundles.js";

export function planRequiresTool(plan: ResearchPlan | undefined, toolName: string): boolean {
  const normalizedTarget = normalizeToolName(toolName);
  for (const tool of plan?.requiredTools ?? []) {
    if (normalizeToolName(tool) === normalizedTarget) return true;
  }
  return false;
}

export function stepRequiresCodexCli(step: ResearchLoopStep, snapshot: ResearchSnapshot): boolean {
  return step === ResearchLoopStep.ExecuteTools && planRequiresTool(snapshot.researchPlans.at(-1), "CodexCliTool");
}

export function collectExecutableToolNames(tools: string[], includeCodexCli: boolean): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  if (includeCodexCli) pushUniqueToolName(output, seen, "CodexCliTool");
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
    if (normalized === "codexclitool") continue;
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

function pushUniqueToolName(output: string[], seen: Set<string>, tool: string): void {
  if (seen.has(tool)) return;
  seen.add(tool);
  output.push(tool);
}

function normalizeToolNameForPlan(value: string): string {
  return value
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}
