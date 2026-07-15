import { durableJobRequestHash } from "./durableJobRequestHash.js";

export interface DurableToolAttemptIdentityInput {
  projectId: string;
  jobId: string;
  toolName: string;
  descriptorVersion?: string;
  repeatable: boolean;
  mutatesExternalState: boolean;
  inputHash: string;
}

export function durableToolAttemptIdentity(input: DurableToolAttemptIdentityInput): { idempotencyKey: string; sideEffectKey?: string } {
  const scope = { projectId: input.projectId, ...(input.repeatable ? { jobId: input.jobId } : {}) };
  const descriptor = { toolName: input.toolName, descriptorVersion: input.descriptorVersion, inputHash: input.inputHash };
  return {
    idempotencyKey: durableJobRequestHash({ version: "tool-attempt-idempotency-v1", ...scope, ...descriptor }),
    ...(input.mutatesExternalState ? { sideEffectKey: durableJobRequestHash({ version: "tool-side-effect-key-v1", ...scope, ...descriptor }) } : {})
  };
}
