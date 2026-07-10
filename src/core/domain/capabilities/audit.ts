import type { JobKind } from "../../../shared/kernel/job.js";
import type { CapabilityDecision, CapabilityDecisionSet, CapabilityGrant, CapabilityResolutionContext, CapabilityScope, CapabilityKind } from "./types.js";

export interface CapabilityAuditPayload {
  recordedAt: string;
  kind: CapabilityKind;
  appId?: string;
  projectId: string;
  jobId?: string;
  jobKind: JobKind;
  appAllowed: boolean;
  projectAllowed: boolean;
  jobAllowed: boolean;
  allowed: boolean;
  blockedBy?: CapabilityScope;
  reason?: string;
  appGrant: CapabilityGrant;
  projectGrant: CapabilityGrant;
  jobGrant: CapabilityGrant;
}

export interface CapabilityAuditInput {
  decision: CapabilityDecision;
  context: CapabilityResolutionContext;
  recordedAt: string;
}

export function buildCapabilityAuditPayload(input: CapabilityAuditInput): CapabilityAuditPayload {
  const { decision, context } = input;
  return {
    recordedAt: input.recordedAt,
    kind: decision.kind,
    appId: context.appId,
    projectId: context.projectId,
    jobId: context.jobId,
    jobKind: context.jobKind,
    appAllowed: decision.appGrant.allowed,
    projectAllowed: decision.projectGrant.allowed,
    jobAllowed: decision.jobGrant.allowed,
    allowed: decision.allowed,
    blockedBy: decision.blockedBy,
    reason: decision.reason,
    appGrant: decision.appGrant,
    projectGrant: decision.projectGrant,
    jobGrant: decision.jobGrant
  };
}

export function buildCapabilityAuditPayloadSet(input: {
  decisions: CapabilityDecisionSet;
  context: CapabilityResolutionContext;
  recordedAt: string;
}): CapabilityAuditPayload[] {
  return [
    buildCapabilityAuditPayload({ decision: input.decisions.agent, context: input.context, recordedAt: input.recordedAt }),
    buildCapabilityAuditPayload({ decision: input.decisions.engineering, context: input.context, recordedAt: input.recordedAt }),
    buildCapabilityAuditPayload({ decision: input.decisions.search, context: input.context, recordedAt: input.recordedAt })
  ];
}
