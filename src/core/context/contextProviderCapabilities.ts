import { z } from "zod";
import { hashContextCanonical } from "./contextCanonical.js";

const StableIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const DerivedCacheCapabilitySchema = z
  .object({
    available: z.boolean(),
    canonicalStateAuthority: z.literal(false),
    role: z.literal("derived_cache_only")
  })
  .strict();

export const ContextProviderCapabilityProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    profileVersion: StableIdentifierSchema,
    structuredOutput: z
      .object({
        supported: z.boolean(),
        transport: z.enum(["json_schema", "none"]),
        strict: z.boolean()
      })
      .strict(),
    nativeContext: DerivedCacheCapabilitySchema,
    nativeCompaction: DerivedCacheCapabilitySchema
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.structuredOutput.supported !== (profile.structuredOutput.transport === "json_schema")) {
      context.addIssue({
        code: "custom",
        path: ["structuredOutput", "transport"],
        message: "Structured-output support and transport must agree."
      });
    }
    if (!profile.structuredOutput.supported && profile.structuredOutput.strict) {
      context.addIssue({ code: "custom", path: ["structuredOutput", "strict"], message: "An unsupported structured-output mode cannot be strict." });
    }
  });

export const ContextProviderCapabilityReceiptSchema = z
  .object({
    profile: ContextProviderCapabilityProfileSchema,
    contentHash: Sha256Schema
  })
  .strict();

export type ContextProviderCapabilityProfile = z.infer<typeof ContextProviderCapabilityProfileSchema>;
export type ContextProviderCapabilityReceipt = z.infer<typeof ContextProviderCapabilityReceiptSchema>;

export const STANDARD_CONTEXT_PROVIDER_CAPABILITY_PROFILE = Object.freeze({
  schemaVersion: 1,
  profileVersion: "provider-capabilities-v1",
  structuredOutput: { supported: true, transport: "json_schema", strict: true },
  nativeContext: { available: false, canonicalStateAuthority: false, role: "derived_cache_only" },
  nativeCompaction: { available: false, canonicalStateAuthority: false, role: "derived_cache_only" }
} satisfies ContextProviderCapabilityProfile);

export const STANDARD_CONTEXT_PROVIDER_CAPABILITY_RECEIPT = Object.freeze({
  profile: STANDARD_CONTEXT_PROVIDER_CAPABILITY_PROFILE,
  contentHash: "3706b83ca843c4f798800f24e415ebee7c14f3606555691a976627573210b0ab"
} satisfies ContextProviderCapabilityReceipt);

export async function createContextProviderCapabilityReceipt(profile: ContextProviderCapabilityProfile): Promise<ContextProviderCapabilityReceipt> {
  const parsed = ContextProviderCapabilityProfileSchema.parse(profile);
  return Object.freeze({ profile: parsed, contentHash: await hashContextCanonical(parsed) });
}

export async function verifyContextProviderCapabilityReceipt(receipt: ContextProviderCapabilityReceipt): Promise<ContextProviderCapabilityReceipt> {
  const parsed = ContextProviderCapabilityReceiptSchema.parse(receipt);
  if ((await hashContextCanonical(parsed.profile)) !== parsed.contentHash) throw new Error("Provider capability receipt hash verification failed.");
  return parsed;
}

export function providerCapabilityProfilePayload(receipt: ContextProviderCapabilityReceipt): ContextProviderCapabilityProfile {
  return receipt.profile;
}
