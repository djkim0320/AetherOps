export type VehicleDomain = "fixed_wing" | "rotorcraft" | "evtol" | "uas" | "propulsion_system" | "aircraft_subsystem" | "experimental" | "other";
export type LifecyclePhase =
  "concept" | "preliminary_design" | "detailed_design" | "integration" | "verification" | "validation" | "operations_support" | "research_only";
export type AssuranceProfile = "exploratory_research" | "engineering_decision_support" | "safety_relevant_support" | "certification_evidence_support";
export type SourceAuthority =
  | "regulatory_primary"
  | "authority_guidance"
  | "invoked_standard"
  | "official_agency_technical"
  | "manufacturer_approved_data"
  | "peer_reviewed"
  | "conference_or_technical_report"
  | "preprint"
  | "general_web"
  | "model_inference";

export interface EngineeringStudyContract {
  id: string;
  schemaVersion: 1;
  revision: number;
  projectId: string;
  objective: string;
  researchQuestions: readonly string[];
  deliverables: readonly { id: string; description: string; format: "markdown" | "json" | "data" }[];
  acceptanceCriteria: readonly { id: string; statement: string; verificationMethod: string; safetyRelevant: boolean }[];
  vehicleProfile: { domain: VehicleDomain; operationContext?: string; crewed?: boolean; configurationBaselineId?: string };
  lifecyclePhase: LifecyclePhase;
  assuranceProfile: AssuranceProfile;
  jurisdictionProfile?: {
    jurisdiction?: string;
    aircraftCategory?: string;
    certificationBasis: readonly string[];
    explicitlyInvokedDocumentIds: readonly string[];
  };
  physicalConventions: {
    canonicalUnitSystem: "SI";
    displayUnitSystem?: string;
    defaultAngleUnit?: "rad" | "deg";
    earthModel?: string;
    atmosphereModel?: string;
    gravityModel?: string;
    requiredFrames: readonly string[];
  };
  sourcePolicy: {
    minimumAuthorityByClaimType: Readonly<Record<string, SourceAuthority>>;
    allowPreprints: boolean;
    allowGeneralWeb: boolean;
    requirePrimarySourcesForStandards: boolean;
    requireRevisionCheck: boolean;
  };
  computeBudget: { toolCalls?: number; cpuSeconds?: number; memoryBytes?: number; diskBytes?: number; wallClockMs?: number; externalCost?: number };
  constraints: readonly { id: string; statement: string; sourceId?: string }[];
  nonGoals: readonly string[];
  assumptionsRequiringApproval: readonly { id: string; statement: string; consequence: string }[];
  safetyRestrictions: readonly { id: string; statement: string; humanReviewRequired: boolean }[];
  provenance: { actor: "user" | "system"; sourceId: string; occurredAt: string; supersedesRevision?: number };
}

export interface EngineeringStudyDraft {
  id: string;
  projectId: string;
  objective: string;
  researchQuestions?: readonly string[];
  vehicleDomain?: VehicleDomain;
  operationContext?: string;
  crewed?: boolean;
  lifecyclePhase?: LifecyclePhase;
  assuranceProfile?: AssuranceProfile;
  requiredFrames?: readonly string[];
  defaultAngleUnit?: "rad" | "deg";
  atmosphereModel?: string;
  configurationBaselineId?: string;
  provenance: EngineeringStudyContract["provenance"];
}

export interface StudyContractNormalization {
  contract?: EngineeringStudyContract;
  openQuestions: readonly { field: string; question: string; safetyRelevant: boolean }[];
  proposedAssuranceProfile: AssuranceProfile;
}

export function normalizeStudyContract(draft: EngineeringStudyDraft): StudyContractNormalization {
  requiredText(draft.id, "Study id");
  requiredText(draft.projectId, "Project id");
  requiredText(draft.objective, "Study objective");
  validateTimestamp(draft.provenance.occurredAt);
  const questions: Array<{ field: string; question: string; safetyRelevant: boolean }> = [];
  if (!draft.vehicleDomain)
    questions.push({ field: "vehicleProfile.domain", question: "어떤 항공기 또는 항공 시스템 유형을 연구합니까?", safetyRelevant: true });
  if (!draft.operationContext)
    questions.push({ field: "vehicleProfile.operationContext", question: "운용 환경과 비행 구간은 무엇입니까?", safetyRelevant: true });
  if (!draft.requiredFrames?.length)
    questions.push({ field: "physicalConventions.requiredFrames", question: "사용할 좌표계와 축/부호 규약은 무엇입니까?", safetyRelevant: true });
  if (!draft.defaultAngleUnit)
    questions.push({ field: "physicalConventions.defaultAngleUnit", question: "각도 입력 단위는 rad입니까 deg입니까?", safetyRelevant: false });
  if (!draft.atmosphereModel)
    questions.push({ field: "physicalConventions.atmosphereModel", question: "적용할 대기 모델과 유효 고도 범위는 무엇입니까?", safetyRelevant: true });
  if (!draft.configurationBaselineId)
    questions.push({ field: "vehicleProfile.configurationBaselineId", question: "형상·질량 기준선 ID는 무엇입니까?", safetyRelevant: true });
  const proposed = conservativeAssurance(
    draft.assuranceProfile,
    questions.some((item) => item.safetyRelevant)
  );
  if (questions.length) return Object.freeze({ openQuestions: Object.freeze(questions), proposedAssuranceProfile: proposed });
  const contract: EngineeringStudyContract = {
    id: draft.id,
    schemaVersion: 1,
    revision: 1,
    projectId: draft.projectId,
    objective: draft.objective.trim(),
    researchQuestions: cleanTexts(draft.researchQuestions ?? [draft.objective]),
    deliverables: [],
    acceptanceCriteria: [],
    vehicleProfile: {
      domain: draft.vehicleDomain as VehicleDomain,
      operationContext: draft.operationContext?.trim(),
      ...(draft.crewed === undefined ? {} : { crewed: draft.crewed }),
      configurationBaselineId: draft.configurationBaselineId
    },
    lifecyclePhase: draft.lifecyclePhase ?? "research_only",
    assuranceProfile: proposed,
    physicalConventions: {
      canonicalUnitSystem: "SI",
      defaultAngleUnit: draft.defaultAngleUnit,
      atmosphereModel: draft.atmosphereModel,
      requiredFrames: Object.freeze([...(draft.requiredFrames as readonly string[])])
    },
    sourcePolicy: {
      minimumAuthorityByClaimType: Object.freeze({ safety: "regulatory_primary", engineering: "official_agency_technical" }),
      allowPreprints: true,
      allowGeneralWeb: proposed === "exploratory_research",
      requirePrimarySourcesForStandards: true,
      requireRevisionCheck: true
    },
    computeBudget: {},
    constraints: [],
    nonGoals: [],
    assumptionsRequiringApproval: [],
    safetyRestrictions: Object.freeze([
      { id: "human-review", statement: "Safety-relevant conclusions require explicit human review.", humanReviewRequired: true },
      { id: "no-hardware-control", statement: "The study cannot control aircraft or test hardware.", humanReviewRequired: true }
    ]),
    provenance: Object.freeze({ ...draft.provenance })
  };
  validateStudyContract(contract);
  return Object.freeze({ contract: deepFreezeContract(contract), openQuestions: Object.freeze([]), proposedAssuranceProfile: proposed });
}

export function validateStudyContract(contract: EngineeringStudyContract): void {
  requiredText(contract.id, "Study id");
  requiredText(contract.projectId, "Project id");
  requiredText(contract.objective, "Study objective");
  if (contract.schemaVersion !== 1 || !Number.isSafeInteger(contract.revision) || contract.revision < 1) throw new Error("Study contract version is invalid.");
  if (contract.physicalConventions.canonicalUnitSystem !== "SI") throw new Error("Engineering canonical units must be SI.");
  if (!contract.physicalConventions.requiredFrames.length) throw new Error("Study contract requires at least one coordinate frame.");
  for (const [name, value] of Object.entries(contract.computeBudget)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`Compute budget ${name} must be positive.`);
  }
  if (!contract.safetyRestrictions.some((item) => item.humanReviewRequired)) throw new Error("Study contract must retain a human-review safety restriction.");
  validateTimestamp(contract.provenance.occurredAt);
}

export function reviseStudyContract(
  previous: EngineeringStudyContract,
  changes: Partial<Pick<EngineeringStudyContract, "objective" | "researchQuestions" | "acceptanceCriteria" | "constraints" | "nonGoals">>,
  provenance: EngineeringStudyContract["provenance"]
): EngineeringStudyContract {
  if (provenance.supersedesRevision !== previous.revision) throw new Error("Study revision provenance must reference the exact previous revision.");
  const revised = { ...previous, ...changes, revision: previous.revision + 1, provenance };
  validateStudyContract(revised);
  return deepFreezeContract(revised);
}

function conservativeAssurance(requested: AssuranceProfile | undefined, ambiguity: boolean): AssuranceProfile {
  if (requested) return requested;
  return ambiguity ? "engineering_decision_support" : "exploratory_research";
}

function cleanTexts(values: readonly string[]): readonly string[] {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (!cleaned.length) throw new Error("At least one research question is required.");
  return Object.freeze(cleaned);
}

function deepFreezeContract(contract: EngineeringStudyContract): EngineeringStudyContract {
  return Object.freeze({
    ...contract,
    researchQuestions: Object.freeze([...contract.researchQuestions]),
    deliverables: Object.freeze(contract.deliverables.map((item) => Object.freeze({ ...item }))),
    acceptanceCriteria: Object.freeze(contract.acceptanceCriteria.map((item) => Object.freeze({ ...item }))),
    physicalConventions: Object.freeze({ ...contract.physicalConventions, requiredFrames: Object.freeze([...contract.physicalConventions.requiredFrames]) }),
    safetyRestrictions: Object.freeze(contract.safetyRestrictions.map((item) => Object.freeze({ ...item })))
  });
}

function requiredText(value: string, label: string): void {
  if (!value.trim() || value.length > 16_384) throw new Error(`${label} is required and bounded.`);
}

function validateTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Study provenance timestamp is invalid.");
}
