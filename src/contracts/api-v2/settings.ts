import { z } from "zod";
import { CapabilityGrantSchema } from "./capabilities.js";
import { EmptyParamsSchema, rpcRequestSchema } from "./common.js";
import { CODEX_MODEL_IDS, CODEX_REASONING_EFFORTS, isCodexModelEffortCompatible } from "../../shared/kernel/codexModels.js";

const nonEmptyString = z.string().trim().min(1);
const positiveTimeoutMs = z.number().int().min(1_000).max(900_000);

export { CapabilityGrantSchema } from "./capabilities.js";

export const CodexModelIdSchema = z.enum(CODEX_MODEL_IDS);
export const CodexReasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);

export const CodexSettingsSchema = z
  .object({
    model: CodexModelIdSchema,
    reasoningEffort: CodexReasoningEffortSchema,
    timeoutMs: positiveTimeoutMs
  })
  .strict()
  .superRefine((value, context) => {
    if (!isCodexModelEffortCompatible(value.model, value.reasoningEffort)) {
      context.addIssue({ code: "custom", message: `${value.reasoningEffort} is not supported by ${value.model}`, path: ["reasoningEffort"] });
    }
  });

export {
  CODEX_MODEL_CATALOG,
  CODEX_MODEL_IDS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_TIMEOUT_MS,
  assertCodexSettings,
  isCodexModelEffortCompatible,
  isCodexModelId
} from "../../shared/kernel/codexModels.js";
export type { CodexModelCategory, CodexModelDescriptor, CodexModelId, CodexReasoningEffort } from "../../shared/kernel/codexModels.js";

export const EmbeddingProviderSchema = z.enum(["openai", "google", "custom", "local"]);

export const EmbeddingSettingsSchema = z
  .object({
    provider: EmbeddingProviderSchema,
    model: nonEmptyString.optional(),
    baseUrl: z.string().url().optional(),
    dimensions: z.number().int().positive().max(65_536),
    apiKeyConfigured: z.boolean()
  })
  .strict();

export const SearchProviderSchema = z.enum(["tavily", "brave", "custom", "disabled"]);

export const SearchSettingsSchema = z
  .object({
    provider: SearchProviderSchema,
    endpoint: z.string().url().optional(),
    timeoutMs: positiveTimeoutMs,
    apiKeyConfigured: z.boolean()
  })
  .strict();

export const SettingsResponseSchema = z
  .object({
    codex: CodexSettingsSchema,
    embedding: EmbeddingSettingsSchema,
    search: SearchSettingsSchema,
    capabilities: CapabilityGrantSchema,
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

const EmbeddingSettingsUpdateSchema = EmbeddingSettingsSchema.omit({ apiKeyConfigured: true })
  .extend({
    apiKey: z.string().trim().min(1).nullable().optional()
  })
  .strict();

const SearchSettingsUpdateSchema = SearchSettingsSchema.omit({ apiKeyConfigured: true })
  .extend({
    apiKey: z.string().trim().min(1).nullable().optional()
  })
  .strict();

/** API keys are accepted only by this write contract and never by response contracts. */
export const SettingsSaveParamsSchema = z
  .object({
    codex: CodexSettingsSchema,
    embedding: EmbeddingSettingsUpdateSchema,
    search: SearchSettingsUpdateSchema,
    capabilities: CapabilityGrantSchema
  })
  .strict();

export const SettingsGetRequestSchema = rpcRequestSchema("settings.get", EmptyParamsSchema);
export const SettingsSaveRequestSchema = rpcRequestSchema("settings.save", SettingsSaveParamsSchema);

export type { CapabilityGrant } from "./capabilities.js";
export type CodexSettings = z.infer<typeof CodexSettingsSchema>;
export type EmbeddingSettings = z.infer<typeof EmbeddingSettingsSchema>;
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;
export type SettingsSaveParams = z.infer<typeof SettingsSaveParamsSchema>;
