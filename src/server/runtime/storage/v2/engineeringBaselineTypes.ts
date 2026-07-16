import type { BaselineAspect, ConfigurationBaseline } from "../../../../core/aerospace/configurationBaseline.js";
import type { EngineeringResultCandidate } from "../../../../core/aerospace/engineeringPromotionPolicy.js";
import type { StorageJobEvent } from "./types.js";

export const ENGINEERING_ARTIFACT_NOT_CURRENT_CODE = "ENGINEERING_ARTIFACT_NOT_CURRENT";

export class EngineeringArtifactNotCurrentError extends Error {
  readonly name = "EngineeringArtifactNotCurrentError";
  readonly code = ENGINEERING_ARTIFACT_NOT_CURRENT_CODE;
}

export interface StorageActivateEngineeringBaselineInput {
  baseline: ConfigurationBaseline;
  expectedRevision: number;
  changeReason: string;
}

export interface StorageActivateEngineeringBaselineResult {
  baseline: ConfigurationBaseline;
  exactReplay: boolean;
  changedAspects: BaselineAspect[];
  stalePromotionIds: string[];
}

export interface StorageActivateEngineeringBaselineTransactionResult {
  activation: StorageActivateEngineeringBaselineResult;
  event: StorageJobEvent;
  publishEvent: boolean;
}

export interface StorageEngineeringResultPromotion extends EngineeringResultCandidate {
  id: string;
  promotedAt: string;
  receiptHash: string;
  staleAt?: string;
  staleReason?: string;
}

export type StorageEngineeringPromotionDraft = Omit<
  EngineeringResultCandidate,
  "schemaVersion" | "projectId" | "jobId" | "attemptId" | "outputLinkId" | "outputId" | "tool" | "postcondition" | "postconditionReceiptHash"
> & {
  executionMedia: string;
};

export interface StorageEngineeringArtifactReadInput {
  projectId: string;
  promotionId: string;
  maximumBytes?: number;
}

export interface StorageEngineeringArtifactReadback {
  promotion: StorageEngineeringResultPromotion;
  artifactUri: string;
  excerptBase64: string;
  excerptBytes: number;
  complete: boolean;
  readAt: string;
  readReceiptHash: string;
}
