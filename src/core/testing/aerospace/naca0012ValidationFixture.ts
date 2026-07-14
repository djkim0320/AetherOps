import { ANGLE, DIMENSIONLESS } from "../../aerospace/dimensions.js";
import type { AerodynamicDatasetPedigree } from "../../aerospace/aerodynamicValidation.js";
import type { AerospaceModelCard } from "../../aerospace/modelCard.js";

export const NACA0012_LADSON_FIXTURE_PATH = "tests/fixtures/aerospace/naca0012-ladson-re6m-m015.dat";
export const NACA0012_LADSON_SHA256 = "78cd2f6aa4968e80f44cbf6c96f699bd9c6e45681d958ec528a10cf72ed23357";
export const NACA0012_BASELINE_ID = "baseline:naca0012";
export const NACA0012_VALIDATION_USE = "NACA 0012 pre-stall force-coefficient validation";

export function naca0012LadsonPedigree(computedContentSha256: string, expectedContentSha256 = NACA0012_LADSON_SHA256): AerodynamicDatasetPedigree {
  return {
    id: "dataset:nasa-tmr-ladson-naca0012-re6m-m015",
    sourceUrl: "https://tmbwg.github.io/turbmodels/NACA0012_validation/CLCD_Ladson_expdata.dat",
    caseUrl: "https://tmbwg.github.io/turbmodels/naca0012_val.html",
    reportIdentifier: "NASA-TM-4074",
    organization: "NASA Langley Research Center",
    accessDate: "2026-07-15T00:00:00.000Z",
    licenseStatus: "public",
    expectedContentSha256,
    computedContentSha256,
    reynoldsNumber: 6_000_000,
    mach: 0.15,
    transition: "tripped",
    geometryDefinition: "NASA TMR 2DN00 altered NACA 0012 sharp-trailing-edge formula",
    coefficientConvention: {
      liftPositive: "upward_normal_to_freestream",
      dragPositive: "opposite_freestream",
      referenceArea: "unit_span_times_chord",
      referenceChord: 1
    }
  };
}

export function naca0012WebXfoilModelCard(): AerospaceModelCard {
  return {
    id: "model:webxfoil-naca0012",
    version: "0.1.1",
    name: "WebXFOIL NACA 0012 validation model",
    discipline: "aerodynamics",
    intendedUses: [NACA0012_VALIDATION_USE],
    permissibleUses: [NACA0012_VALIDATION_USE],
    prohibitedUses: ["certification finding"],
    physicalPhenomena: ["viscous two-dimensional airfoil flow"],
    abstractions: ["two-dimensional steady viscous-inviscid interaction"],
    assumptions: ["source-bound forced transition", "pre-stall steady solution"],
    excludedEffects: ["three-dimensional tunnel effects", "unsteady stall"],
    governingEquationIds: ["xfoil-governing-equations"],
    tool: { id: "webxfoil-wasm", version: "0.1.1", numericalMethods: ["XFOIL viscous-inviscid interaction"] },
    verificationDomain: validationConstraints(),
    validationDomain: validationConstraints(),
    verificationEvidenceIds: ["test:webxfoil-adapter"],
    validationEvidenceIds: ["dataset:nasa-tmr-ladson-naca0012-re6m-m015"],
    dataPedigreeIds: ["dataset:nasa-tmr-ladson-naca0012-re6m-m015"],
    knownDefects: [],
    uncertaintyModelId: "uncertainty:experimental-not-quantified",
    sensitivityEvidenceIds: ["sensitivity:angle-of-attack"],
    reviewStatus: "technical_review"
  };
}

function validationConstraints(): AerospaceModelCard["validationDomain"] {
  return [
    {
      variableId: "reynoldsNumber",
      dimension: DIMENSIONLESS,
      minimumSI: 5_900_000,
      maximumSI: 6_100_000,
      configurationBaselineIds: [NACA0012_BASELINE_ID]
    },
    { variableId: "mach", dimension: DIMENSIONLESS, minimumSI: 0.14, maximumSI: 0.16 },
    { variableId: "alpha", dimension: ANGLE, minimumSI: (-4 * Math.PI) / 180, maximumSI: (17 * Math.PI) / 180 }
  ];
}
