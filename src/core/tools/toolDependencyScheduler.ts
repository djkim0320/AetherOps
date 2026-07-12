import { normalizeToolName, orderToolNames } from "./toolMerger.js";
import type { ResearchPlan } from "../shared/types.js";
import { getToolDescriptorOrCustom, type ToolDescriptor, type ToolPhase } from "./toolDescriptors.js";

export interface ToolFilterOptions {
  includeTools?: string[];
  excludeTools?: string[];
}

export function normalizedRequiredTools(requiredTools: string[]): string[] {
  const normalized: string[] = [];
  for (const tool of orderToolNames(requiredTools)) {
    const name = normalizeToolName(tool);
    if (name) normalized.push(name);
  }
  return normalized;
}

export function filterRequiredTools(requiredTools: string[], options: ToolFilterOptions): string[] {
  const include = normalizedToolFilter(options.includeTools);
  const exclude = normalizedToolFilter(options.excludeTools);
  const filtered: string[] = [];
  for (const tool of requiredTools) {
    if (include && !include.has(tool)) continue;
    if (exclude?.has(tool)) continue;
    filtered.push(tool);
  }
  return filtered;
}

export function normalizedToolFilter(tools: string[] | undefined): Set<string> | undefined {
  if (!tools?.length) return undefined;
  const normalized = new Set<string>();
  for (const tool of tools) {
    const name = normalizeToolName(tool);
    if (name) normalized.add(name);
  }
  return normalized;
}

export function orderedToolNames(values: string[]): string[] {
  return orderToolNames(values);
}

export interface ScheduledToolAction {
  actionId: string;
  decisionId: string;
  toolName: string;
  normalizedName: string;
  descriptor: ToolDescriptor;
  inputs: Record<string, unknown>;
  purpose: string;
  expectedOutcome: string;
  ordinal: number;
  dependsOnActionIds: string[];
}

export interface ToolExecutionSchedule {
  actions: ScheduledToolAction[];
  phases: Array<{ phase: ToolPhase; actions: ScheduledToolAction[] }>;
}

const phaseOrder: ToolPhase[] = ["acquisition.discovery", "acquisition.fetch", "binding", "exclusive", "analysis", "artifact"];

export function buildToolExecutionSchedule(plan: ResearchPlan | undefined, options: ToolFilterOptions = {}): ToolExecutionSchedule {
  if (!plan) return { actions: [], phases: [] };
  if (!plan.toolRequests?.length) throw new Error("Tool execution requires validated ResearchPlan.toolRequests.");
  const actions: ScheduledToolAction[] = [];
  const requests = plan.toolRequests;
  const include = normalizedToolFilter(options.includeTools);
  const exclude = normalizedToolFilter(options.excludeTools);
  for (const request of requests) {
    const toolName = normalizeToolName(request.toolName);
    if (include && !include.has(toolName)) continue;
    if (exclude?.has(toolName)) continue;
    const descriptor = getToolDescriptorOrCustom(request.toolName ?? toolName);
    const parsed = descriptor.inputSchema.safeParse(request?.inputs ?? {});
    if (!parsed.success) throw new Error(`${descriptor.name} inputs failed execution validation: ${parsed.error.issues[0]?.message ?? "invalid inputs"}`);
    actions.push({
      actionId: request.intentId,
      decisionId: request.intentId,
      toolName: descriptor.name,
      normalizedName: normalizeToolName(descriptor.name),
      descriptor,
      inputs: parsed.data,
      purpose: request.purpose,
      expectedOutcome: request.expectedOutcome,
      ordinal: actions.length,
      dependsOnActionIds: []
    });
  }
  actions.sort(compareActions);
  for (let index = 0; index < actions.length; index += 1) (actions[index] as ScheduledToolAction).ordinal = index;
  assertDependencies(actions);
  compileDependencies(actions);
  return {
    actions,
    phases: phaseOrder
      .map((phase) => ({ phase, actions: actions.filter((action) => action.descriptor.phase === phase) }))
      .filter((group) => group.actions.length > 0)
  };
}

function compileDependencies(actions: ScheduledToolAction[]): void {
  for (const action of actions) {
    const dependencies = new Set<string>();
    const actionPhase = phaseOrder.indexOf(action.descriptor.phase);
    for (const candidate of actions) {
      if (candidate.actionId === action.actionId) continue;
      if (phaseOrder.indexOf(candidate.descriptor.phase) < actionPhase) dependencies.add(candidate.actionId);
      if (action.descriptor.dependencies.some((name) => normalizeToolName(name) === candidate.normalizedName)) dependencies.add(candidate.actionId);
    }
    action.dependsOnActionIds = [...dependencies].sort((left, right) => {
      const leftOrdinal = actions.find((item) => item.actionId === left)?.ordinal ?? 0;
      const rightOrdinal = actions.find((item) => item.actionId === right)?.ordinal ?? 0;
      return leftOrdinal - rightOrdinal || left.localeCompare(right);
    });
  }
}

function compareActions(left: ScheduledToolAction, right: ScheduledToolAction): number {
  const phaseDelta = phaseOrder.indexOf(left.descriptor.phase) - phaseOrder.indexOf(right.descriptor.phase);
  if (phaseDelta) return phaseDelta;
  const leftIndex = canonicalPhaseToolOrder.indexOf(left.normalizedName);
  const rightIndex = canonicalPhaseToolOrder.indexOf(right.normalizedName);
  if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (leftIndex >= 0 && rightIndex < 0) return -1;
  if (rightIndex >= 0 && leftIndex < 0) return 1;
  return left.ordinal - right.ordinal || left.actionId.localeCompare(right.actionId);
}

const canonicalPhaseToolOrder = [
  "websearchtool",
  "backgroundbrowsertool",
  "researchmetadatatool",
  "webfetchtool",
  "pdfingestiontool",
  "codexclitool",
  "engineeringprogramtool",
  "dataanalysistool",
  "artifactwritertool"
];

function assertDependencies(actions: ScheduledToolAction[]): void {
  const selected = new Set(actions.map((action) => action.normalizedName));
  for (const action of actions) {
    for (const dependency of action.descriptor.dependencies) {
      if (!selected.has(normalizeToolName(dependency))) {
        throw new Error(`${action.toolName} requires ${dependency} in the same validated execution plan.`);
      }
    }
  }
}
