export const CAPABILITY_KINDS = ["agent", "engineering", "search"] as const;

export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const CAPABILITY_SCOPES = ["app", "project", "operation"] as const;

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];
