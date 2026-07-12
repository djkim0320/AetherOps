import type {
  CapabilityKind,
  CapabilityPolicy,
  CapabilityResolutionContext,
  CapabilityResolutionInput,
  CapabilityDecision,
  CapabilityDecisionSet,
  CapabilityGrant,
  CapabilityScope
} from "./types.js";
import type { JobKind } from "../../../shared/kernel/job.js";

export const JOB_KIND_CAPABILITY_POLICY: Record<JobKind, CapabilityPolicy> = {
  research_loop: { agent: true, engineering: false, search: false },
  chat_reply: { agent: true, engineering: false, search: false },
  engineering_run: { agent: true, engineering: true, search: false }
};

export class CapabilityResolverError extends Error {
  readonly code: "invalid_policy" | "invalid_kind";

  constructor(code: CapabilityResolverError["code"], message: string) {
    super(message);
    this.name = "CapabilityResolverError";
    this.code = code;
  }
}

export class CapabilityResolver {
  resolve(kind: CapabilityKind, input: CapabilityResolutionInput): CapabilityDecision {
    const jobPolicy = buildJobPolicy(input.jobKind, input.job);
    const appAllowed = readCapability(input.app, kind, "app");
    const projectAllowed = readCapability(input.project, kind, "project");
    const jobAllowed = readCapability(jobPolicy, kind, "job");
    const allowed = appAllowed && projectAllowed && jobAllowed;
    const blockedBy = allowed ? undefined : !appAllowed ? "app" : !projectAllowed ? "project" : "job";

    const appGrant = buildGrant("app", kind, appAllowed, blockedBy === "app" ? denyReason("app", kind, input) : undefined);
    const projectGrant = buildGrant("project", kind, projectAllowed, blockedBy === "project" ? denyReason("project", kind, input) : undefined);
    const jobGrant = buildGrant("job", kind, jobAllowed, blockedBy === "job" ? denyReason("job", kind, input) : undefined);

    return {
      kind,
      appGrant,
      projectGrant,
      jobGrant,
      allowed,
      blockedBy,
      reason: allowed ? undefined : denyReason(blockedBy ?? "job", kind, input)
    };
  }

  resolveSet(input: CapabilityResolutionInput): CapabilityDecisionSet {
    return {
      agent: this.resolve("agent", input),
      engineering: this.resolve("engineering", input),
      search: this.resolve("search", input)
    };
  }

  static defaultJobPolicy(kind: JobKind): CapabilityPolicy {
    return { ...JOB_KIND_CAPABILITY_POLICY[kind] };
  }
}

export function resolveCapabilitySet(input: CapabilityResolutionInput): CapabilityDecisionSet {
  return new CapabilityResolver().resolveSet(input);
}

export function defaultJobCapabilityPolicy(kind: JobKind): CapabilityPolicy {
  return CapabilityResolver.defaultJobPolicy(kind);
}

function buildJobPolicy(kind: JobKind, override?: Partial<CapabilityPolicy>): CapabilityPolicy {
  const base = defaultJobCapabilityPolicy(kind);
  if (!override) return base;
  return {
    agent: override.agent ?? base.agent,
    engineering: override.engineering ?? base.engineering,
    search: override.search ?? base.search
  };
}

function buildGrant(scope: CapabilityScope, kind: CapabilityKind, allowed: boolean, reason?: string): CapabilityGrant {
  return {
    scope,
    kind,
    allowed,
    reason
  };
}

function readCapability(policy: CapabilityPolicy, kind: CapabilityKind, scope: CapabilityScope): boolean {
  const value = policy[kind];
  if (typeof value !== "boolean") {
    throw new CapabilityResolverError("invalid_policy", `Capability policy for ${scope}.${kind} must be boolean.`);
  }
  return value;
}

function denyReason(scope: CapabilityScope, kind: CapabilityKind, input: CapabilityResolutionContext): string {
  if (scope === "app") return `App capability policy denies ${kind}.`;
  if (scope === "project") return `Project ${input.projectId} capability policy denies ${kind}.`;
  if (scope === "job") return `Job ${input.jobId ?? "<unassigned>"} of kind ${input.jobKind} does not permit ${kind}.`;
  return `Capability ${kind} is denied by ${scope}.`;
}
