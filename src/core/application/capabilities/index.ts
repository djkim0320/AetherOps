import {
  buildCapabilityAuditPayload,
  buildCapabilityAuditPayloadSet,
  CapabilityResolver,
  type CapabilityAuditPayload,
  type CapabilityDecisionSet,
  type CapabilityPolicy,
  type CapabilityResolutionContext,
  type CapabilityResolutionInput,
  defaultJobCapabilityPolicy,
  resolveCapabilitySet,
  JOB_KIND_CAPABILITY_POLICY
} from "../../domain/capabilities/index.js";
import type { JobKind } from "../../../shared/kernel/job.js";

export const JOB_KIND_REQUIRED_CAPABILITIES: Record<JobKind, readonly (keyof CapabilityDecisionSet)[]> = {
  research_loop: ["agent", "search"],
  chat_reply: ["agent"],
  engineering_run: ["agent", "engineering"]
};

export interface CapabilityAuthorizationInput extends CapabilityResolutionInput {
  recordedAt: string;
}

export interface CapabilityAuthorizationResult {
  decisions: CapabilityDecisionSet;
  allowed: boolean;
  audits: CapabilityAuditPayload[];
  requiredCapabilityKinds: readonly (keyof CapabilityDecisionSet)[];
}

export function authorizeJobCapabilities(input: CapabilityAuthorizationInput): CapabilityAuthorizationResult {
  const decisions = resolveCapabilitySet(input);
  const requiredCapabilityKinds = JOB_KIND_REQUIRED_CAPABILITIES[input.jobKind];
  const allowed = requiredCapabilityKinds.every((kind) => decisions[kind].allowed);
  return {
    decisions,
    allowed,
    audits: buildCapabilityAuditPayloadSet({
      decisions,
      context: input,
      recordedAt: input.recordedAt
    }),
    requiredCapabilityKinds
  };
}

export {
  buildCapabilityAuditPayload,
  buildCapabilityAuditPayloadSet,
  CapabilityResolver,
  JOB_KIND_CAPABILITY_POLICY,
  defaultJobCapabilityPolicy,
  type CapabilityAuditPayload,
  type CapabilityDecisionSet,
  type CapabilityPolicy,
  type CapabilityResolutionContext,
  type CapabilityResolutionInput,
  type JobKind
};
