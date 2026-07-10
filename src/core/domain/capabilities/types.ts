import type { JobKind } from "../../../shared/kernel/job.js";

export const CAPABILITY_KINDS = ["agent", "engineering", "search"] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const CAPABILITY_SCOPES = ["app", "project", "job"] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export type CapabilityPolicy = Record<CapabilityKind, boolean>;

export interface CapabilityGrant {
  scope: CapabilityScope;
  kind: CapabilityKind;
  allowed: boolean;
  reason?: string;
}

export interface CapabilityDecision {
  kind: CapabilityKind;
  appGrant: CapabilityGrant;
  projectGrant: CapabilityGrant;
  jobGrant: CapabilityGrant;
  allowed: boolean;
  blockedBy?: CapabilityScope;
  reason?: string;
}

export type CapabilityDecisionSet = Record<CapabilityKind, CapabilityDecision>;

export interface CapabilityResolutionInput {
  app: CapabilityPolicy;
  project: CapabilityPolicy;
  jobKind: JobKind;
  job?: Partial<CapabilityPolicy>;
  appId?: string;
  projectId: string;
  jobId?: string;
}

export interface CapabilityResolutionContext {
  appId?: string;
  projectId: string;
  jobId?: string;
  jobKind: JobKind;
}
