import type { AerospaceDiscipline } from "../aerospace/modelCard.js";

export interface AerospaceToolMetadata {
  discipline: AerospaceDiscipline;
  fidelity: 0 | 1 | 2 | 3 | 4;
  intendedUses: string[];
  validInputEnvelope: string;
  quantityKinds: string[];
  frameKinds: string[];
  deterministic: boolean;
  solverRequirements: string[];
  licenseRequirement: "none" | "open_source" | "user_supplied" | "commercial";
  resourceBudget: { cpuSeconds: number; memoryBytes: number; diskBytes: number; wallClockMs: number };
  inputArtifactTypes: string[];
  outputArtifactTypes: string[];
  preconditions: string[];
  postconditions: string[];
  verificationStrategy: string;
  supportsUncertainty: boolean;
  supportsSensitivity: boolean;
  qualificationStatus: "unqualified_research" | "verified_fixture" | "user_qualified";
  externalSideEffectRisk: "none" | "bounded_compute" | "network" | "mutating";
  schemaByteEstimate: number;
}
