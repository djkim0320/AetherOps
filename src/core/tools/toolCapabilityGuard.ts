import type { ToolExecutionContext } from "./researchToolTypes.js";
import type { ScheduledToolAction } from "./toolDependencyScheduler.js";

export async function assertToolActionAllowed(action: ScheduledToolAction, execution?: ToolExecutionContext): Promise<void> {
  const effective = execution?.authorizeAction
    ? await execution.authorizeAction({ name: action.toolName, requiredCapabilities: action.descriptor.requiredCapabilities, inputs: action.inputs })
    : execution?.effectiveCapabilities;
  const denied = action.descriptor.requiredCapabilities.filter((capability) => effective?.[capability] === false);
  if (denied.length) throw new Error(`${action.toolName} is denied by job capabilities: ${denied.join(", ")}.`);
}
