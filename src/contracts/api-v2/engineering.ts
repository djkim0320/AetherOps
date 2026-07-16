import { z } from "zod";
import { CapabilityGrantSchema } from "./settings.js";
import { JobReceiptSchema } from "./jobs.js";
import { TimestampSchema, rpcRequestSchema } from "./common.js";

const identifier = z.string().trim().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const boundedIdentifierList = z
  .array(identifier)
  .max(512)
  .refine((values) => new Set(values).size === values.length, "Identifiers must be unique.");
const DimensionVectorSchema = z
  .object({
    mass: z.number(),
    length: z.number(),
    time: z.number(),
    temperature: z.number(),
    current: z.number(),
    amount: z.number(),
    luminousIntensity: z.number(),
    angle: z.number()
  })
  .strict();
const QuantityProvenanceSchema = z
  .object({ sourceType: z.enum(["user", "source", "calculation", "solver", "measurement"]), sourceId: identifier, receiptId: identifier.optional() })
  .strict();
const EngineeringQuantitySchema = z
  .object({
    kind: z.literal("scalar"),
    valueSI: z.number().finite(),
    dimension: DimensionVectorSchema,
    semantic: z.enum(["generic", "absolute_temperature", "temperature_difference", "absolute_pressure", "gauge_pressure", "angle", "mach", "coefficient"]),
    originalValue: z.number().finite(),
    originalUnit: z.string().trim().min(1).max(64),
    displayUnit: z.string().trim().min(1).max(64),
    provenance: QuantityProvenanceSchema,
    serializationVersion: z.literal(1)
  })
  .strict();
const FramedPositionSchema = z
  .object({
    components: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    frameId: identifier,
    quantityKind: z.literal("position"),
    unit: z.string().trim().min(1).max(64),
    referencePointId: identifier.optional()
  })
  .strict();
const Matrix3Schema = z.tuple([
  z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
]);
const AerodynamicReferenceSchema = z
  .object({
    area: EngineeringQuantitySchema,
    chord: EngineeringQuantitySchema.optional(),
    span: EngineeringQuantitySchema.optional(),
    momentReferencePointId: identifier.optional(),
    axisConventionId: identifier,
    dynamicPressureDefinition: z.string().trim().min(1).max(1_000)
  })
  .strict();
const MassPropertiesSchema = z
  .object({
    mass: EngineeringQuantitySchema,
    centerOfGravity: FramedPositionSchema,
    inertiaTensor: z
      .object({ componentsSI: Matrix3Schema, frameId: identifier, referencePointId: identifier, unit: z.literal("kg*m^2") })
      .strict()
      .optional()
  })
  .strict();
const BaselineProvenanceSchema = z.object({ id: identifier, contentHash: sha256.optional() }).strict();

export const EngineeringConfigurationBaselineDraftSchema = z
  .object({
    geometryHash: sha256.optional(),
    airfoilGeometryHash: sha256.optional(),
    aerodynamicReference: AerodynamicReferenceSchema.optional(),
    massProperties: MassPropertiesSchema.optional(),
    massPropertiesHash: sha256.optional(),
    atmosphereModelId: identifier.optional(),
    propulsionModelId: identifier.optional(),
    unitConventionId: identifier,
    coordinateConventionId: identifier,
    solverVersions: z.record(identifier, z.string().trim().min(1).max(256)),
    materialRevisionIds: boundedIdentifierList,
    sourceRevisionIds: boundedIdentifierList,
    equationVersionIds: boundedIdentifierList,
    createdBy: identifier,
    provenance: z
      .array(BaselineProvenanceSchema)
      .min(1)
      .max(512)
      .refine((values) => new Set(values.map((value) => value.id)).size === values.length, "Provenance identifiers must be unique.")
  })
  .strict();

export const EngineeringConfigurationBaselineSchema = EngineeringConfigurationBaselineDraftSchema.extend({
  id: identifier,
  projectId: identifier,
  revision: z.number().int().positive(),
  status: z.enum(["draft", "active", "superseded", "archived"]),
  contentHash: sha256,
  createdAt: TimestampSchema
}).strict();

export const EngineeringBaselineActivateParamsSchema = z
  .object({
    projectId: identifier,
    expectedRevision: z.number().int().nonnegative(),
    changeReason: z.string().trim().min(1).max(2_000),
    baseline: EngineeringConfigurationBaselineDraftSchema
  })
  .strict();
export const EngineeringBaselineGetParamsSchema = z.object({ projectId: identifier, baselineId: identifier.optional() }).strict();
export const EngineeringBaselineListParamsSchema = z.object({ projectId: identifier, limit: z.number().int().min(1).max(500).optional() }).strict();
export const EngineeringArtifactReadParamsSchema = z
  .object({ projectId: identifier, promotionId: identifier, maximumBytes: z.number().int().min(1).max(65_536).optional() })
  .strict();

export const EngineeringBaselineActivateResponseSchema = z
  .object({
    baseline: EngineeringConfigurationBaselineSchema,
    exactReplay: z.boolean(),
    changedAspects: z.array(z.string().trim().min(1)),
    stalePromotionIds: z.array(identifier)
  })
  .strict();
export const EngineeringBaselineListResponseSchema = z.object({ baselines: z.array(EngineeringConfigurationBaselineSchema) }).strict();
export const EngineeringArtifactReadResponseSchema = z
  .object({
    promotionId: identifier,
    artifactUri: z.string().startsWith("artifact://"),
    sha256,
    byteLength: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1),
    excerptBase64: z.string(),
    excerptBytes: z.number().int().nonnegative(),
    complete: z.boolean(),
    readAt: TimestampSchema,
    readReceiptHash: sha256,
    baselineId: identifier,
    baselineRevision: z.number().int().positive()
  })
  .strict();

export const EngineeringTargetSchema = z.enum(["xfoil", "webxfoil", "su2", "openvsp", "xflr5", "mesh", "codex"]);

export const EngineeringRequestSchema = z
  .object({
    target: EngineeringTargetSchema,
    objective: z.string().trim().min(1).max(20_000),
    inputs: z.record(z.string(), z.unknown())
  })
  .strict();

export const EngineeringEnqueueParamsSchema = z
  .object({
    projectId: identifier,
    idempotencyKey: identifier,
    requests: z.array(EngineeringRequestSchema).min(1).max(16),
    requestedCapabilities: CapabilityGrantSchema
  })
  .strict();

export const EngineeringPreflightParamsSchema = z
  .object({
    projectId: identifier,
    targets: z.array(EngineeringTargetSchema).min(1).max(6),
    requestedCapabilities: CapabilityGrantSchema
  })
  .strict();

export const EngineeringJobReceiptSchema = JobReceiptSchema.refine((receipt) => receipt.kind === "engineering_run", {
  message: "engineering receipt kind must be engineering_run",
  path: ["kind"]
});

export const EngineeringPreflightItemSchema = z
  .object({
    target: EngineeringTargetSchema,
    ready: z.boolean(),
    reason: z.string().trim().min(1).optional()
  })
  .strict();

export const EngineeringPreflightResponseSchema = z
  .object({
    projectId: identifier,
    ready: z.boolean(),
    capabilities: CapabilityGrantSchema,
    targets: z.array(EngineeringPreflightItemSchema),
    checkedAt: TimestampSchema
  })
  .strict();

export const EngineeringEnqueueRequestSchema = rpcRequestSchema("engineering.enqueue", EngineeringEnqueueParamsSchema);
export const EngineeringPreflightRequestSchema = rpcRequestSchema("engineering.preflight", EngineeringPreflightParamsSchema);
export const EngineeringBaselineActivateRequestSchema = rpcRequestSchema("engineering.baseline.activate", EngineeringBaselineActivateParamsSchema);
export const EngineeringBaselineGetRequestSchema = rpcRequestSchema("engineering.baseline.get", EngineeringBaselineGetParamsSchema);
export const EngineeringBaselineListRequestSchema = rpcRequestSchema("engineering.baseline.list", EngineeringBaselineListParamsSchema);
export const EngineeringArtifactReadRequestSchema = rpcRequestSchema("engineering.artifact.read", EngineeringArtifactReadParamsSchema);

export type EngineeringTarget = z.infer<typeof EngineeringTargetSchema>;
export type EngineeringRequest = z.infer<typeof EngineeringRequestSchema>;
export type EngineeringEnqueueParams = z.infer<typeof EngineeringEnqueueParamsSchema>;
export type EngineeringPreflightParams = z.infer<typeof EngineeringPreflightParamsSchema>;
export type EngineeringJobReceipt = z.infer<typeof EngineeringJobReceiptSchema>;
export type EngineeringPreflightResponse = z.infer<typeof EngineeringPreflightResponseSchema>;
export type EngineeringConfigurationBaselineDraft = z.infer<typeof EngineeringConfigurationBaselineDraftSchema>;
export type EngineeringConfigurationBaseline = z.infer<typeof EngineeringConfigurationBaselineSchema>;
export type EngineeringBaselineActivateParams = z.infer<typeof EngineeringBaselineActivateParamsSchema>;
export type EngineeringBaselineGetParams = z.infer<typeof EngineeringBaselineGetParamsSchema>;
export type EngineeringBaselineListParams = z.infer<typeof EngineeringBaselineListParamsSchema>;
export type EngineeringArtifactReadParams = z.infer<typeof EngineeringArtifactReadParamsSchema>;
