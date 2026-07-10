import { z } from "zod";

import { CAPABILITY_KINDS } from "../../shared/kernel/capability.js";

const capabilityFields = Object.fromEntries(CAPABILITY_KINDS.map((capability) => [capability, z.boolean()])) as Record<
  (typeof CAPABILITY_KINDS)[number],
  z.ZodBoolean
>;

export const CapabilitySetSchema = z.object(capabilityFields).strict();

/** A requested or configured capability grant. Effective access is resolved server-side. */
export const CapabilityGrantSchema = CapabilitySetSchema;

export const CapabilityDecisionSchema = z
  .object({
    allowed: CapabilitySetSchema,
    denied: z.array(z.enum(CAPABILITY_KINDS)),
    evaluatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export type CapabilitySet = z.infer<typeof CapabilitySetSchema>;
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type CapabilityDecision = z.infer<typeof CapabilityDecisionSchema>;
