import type { ConfigurationBaseline } from "../../core/aerospace/configurationBaseline.js";
import { ResearchLoopStep } from "../../core/shared/types.js";
import { RuntimeRequirementError } from "../../core/tools/runtimeRequirements.js";
import type { DurableEngineeringBaselineBinding } from "./durableJobTypes.js";

export function assertBoundEngineeringBaseline(
  binding: DurableEngineeringBaselineBinding | null | undefined,
  active: ConfigurationBaseline | undefined
): ConfigurationBaseline {
  if (binding === undefined) {
    throw baselineRequirement("This legacy job has no immutable engineering baseline binding and must be replanned.");
  }
  if (binding === null) {
    throw baselineRequirement("Engineering execution was not admitted because no active configuration baseline existed at enqueue.");
  }
  if (!active) throw baselineRequirement("The configuration baseline bound at enqueue is no longer active.");
  if (active.id !== binding.id || active.revision !== binding.revision || active.contentHash !== binding.contentHash) {
    throw baselineRequirement("The active configuration baseline changed after enqueue; re-enqueue against the active revision.");
  }
  return active;
}

function baselineRequirement(message: string): RuntimeRequirementError {
  return new RuntimeRequirementError(ResearchLoopStep.ExecuteTools, [
    {
      key: "engineering.configurationBaseline",
      label: "Frozen engineering configuration baseline",
      requiredForSteps: [ResearchLoopStep.ExecuteTools],
      isSatisfied: false,
      message
    }
  ]);
}
