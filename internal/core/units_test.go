package core

import (
	"strings"
	"testing"
)

func TestKnowledgeTypedLiteralUnitRegistryV1(t *testing.T) {
	tests := []struct {
		name, datatype, lexical, unit, siValue, siUnit string
	}{
		{name: "dimensionless coefficient", datatype: "http://www.w3.org/2001/XMLSchema#decimal", lexical: "0.01005273", unit: "1", siValue: "0.01005273", siUnit: "1"},
		{name: "length", datatype: KnowledgeDatatypeLength, lexical: "1500", unit: "mm", siValue: "1.5", siUnit: "m"},
		{name: "area", datatype: KnowledgeDatatypeArea, lexical: "10000", unit: "cm2", siValue: "1", siUnit: "m2"},
		{name: "mass", datatype: KnowledgeDatatypeMass, lexical: "1000", unit: "g", siValue: "1", siUnit: "kg"},
		{name: "time", datatype: KnowledgeDatatypeTime, lexical: "2", unit: "min", siValue: "120", siUnit: "s"},
		{name: "speed", datatype: KnowledgeDatatypeSpeed, lexical: "36", unit: "km/h", siValue: "10", siUnit: "m/s"},
		{name: "pressure", datatype: KnowledgeDatatypePressure, lexical: "1.5", unit: "MPa", siValue: "1500000", siUnit: "Pa"},
		{name: "angle", datatype: KnowledgeDatatypeAngle, lexical: "90", unit: "deg", siValue: "1.57079632679489655", siUnit: "rad"},
		{name: "temperature", datatype: KnowledgeDatatypeTemperature, lexical: "25", unit: "C", siValue: "298.15", siUnit: "K"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			literal := KnowledgeTypedLiteral{
				LexicalForm: test.lexical, Datatype: test.datatype, Unit: test.unit,
				SIValue: test.siValue, SIUnit: test.siUnit,
			}
			if err := literal.ValidateWithUnitRegistry(UnitRegistryVersionV1); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestKnowledgeTypedLiteralRejectsInvalidUnitsAndProjection(t *testing.T) {
	tests := []struct {
		name    string
		literal KnowledgeTypedLiteral
		want    string
	}{
		{
			name:    "dimensioned without unit",
			literal: KnowledgeTypedLiteral{LexicalForm: "1", Datatype: KnowledgeDatatypeLength},
			want:    "requires a unit",
		},
		{
			name:    "unsupported unit",
			literal: KnowledgeTypedLiteral{LexicalForm: "1", Datatype: KnowledgeDatatypeLength, Unit: "inch", SIValue: "0.0254", SIUnit: "m"},
			want:    "unsupported knowledge unit",
		},
		{
			name:    "dimensionless unit for dimensioned datatype",
			literal: KnowledgeTypedLiteral{LexicalForm: "1", Datatype: KnowledgeDatatypeLength, Unit: "1", SIValue: "1", SIUnit: "1"},
			want:    "want length",
		},
		{
			name:    "unsupported arbitrary dimensionless unit",
			literal: KnowledgeTypedLiteral{LexicalForm: "0.8", Datatype: "http://www.w3.org/2001/XMLSchema#decimal", Unit: "coefficient", SIValue: "0.8", SIUnit: "1"},
			want:    "unsupported knowledge unit",
		},
		{
			name:    "wrong dimension",
			literal: KnowledgeTypedLiteral{LexicalForm: "1", Datatype: KnowledgeDatatypePressure, Unit: "mm", SIValue: "0.001", SIUnit: "m"},
			want:    "want pressure",
		},
		{
			name:    "wrong projection",
			literal: KnowledgeTypedLiteral{LexicalForm: "36", Datatype: KnowledgeDatatypeSpeed, Unit: "km/h", SIValue: "9.9", SIUnit: "m/s"},
			want:    "does not equal deterministic",
		},
		{
			name:    "NaN source",
			literal: KnowledgeTypedLiteral{LexicalForm: "NaN", Datatype: KnowledgeDatatypeLength, Unit: "m", SIValue: "0", SIUnit: "m"},
			want:    "NaN or infinite",
		},
		{
			name:    "infinite SI",
			literal: KnowledgeTypedLiteral{LexicalForm: "1", Datatype: KnowledgeDatatypeLength, Unit: "m", SIValue: "Inf", SIUnit: "m"},
			want:    "NaN or infinite",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.literal.ValidateWithUnitRegistry(UnitRegistryVersionV1)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestKnowledgePatchCanonicalizesModelUnitProjection(t *testing.T) {
	patch := KnowledgePatch{
		SchemaVersion: KnowledgePatchSchemaV1, UnitRegistryVersion: UnitRegistryVersionV1,
		Entities: []KnowledgeEntity{{ID: "flap", Type: "observation", CanonicalName: "Flap setting", Aliases: []KnowledgeAlias{}}},
		Assertions: []KnowledgeAssertion{{
			ID: "deflection", SubjectEntityID: "flap", Predicate: "has_deflection",
			ObjectLiteral: &KnowledgeTypedLiteral{LexicalForm: "15", Datatype: KnowledgeDatatypeAngle, Unit: "deg", SIValue: "0.2617993877991494", SIUnit: "rad"},
			Qualifiers:    []KnowledgeQualifier{}, Evidence: []KnowledgeEvidenceRef{{
				Kind: KnowledgeEvidenceEngineering, ArtifactHash: strings.Repeat("a", 64), JSONPointer: "/target/deflection", ValueHash: strings.Repeat("b", 64),
			}},
		}},
	}
	if err := patch.CanonicalizeUnitProjections(); err != nil {
		t.Fatal(err)
	}
	if got := patch.Assertions[0].ObjectLiteral.SIValue; got != "0.261799387799149425" {
		t.Fatalf("canonical SI value = %q", got)
	}
	if err := patch.ValidateStructure(); err != nil {
		t.Fatalf("canonicalized patch rejected: %v", err)
	}
}

func TestKnowledgePatchCanonicalizationRejectsWrongSIUnit(t *testing.T) {
	patch := KnowledgePatch{UnitRegistryVersion: UnitRegistryVersionV1, Assertions: []KnowledgeAssertion{{
		ID: "bad", ObjectLiteral: &KnowledgeTypedLiteral{LexicalForm: "15", Datatype: KnowledgeDatatypeAngle, Unit: "deg", SIValue: "15", SIUnit: "m"},
	}}}
	if err := patch.CanonicalizeUnitProjections(); err == nil || !strings.Contains(err.Error(), "want \"rad\"") {
		t.Fatalf("wrong SI unit error = %v", err)
	}
}

func TestKnowledgePatchDimensionlessEngineeringCoefficientUnitOne(t *testing.T) {
	patch := KnowledgePatch{
		SchemaVersion:       KnowledgePatchSchemaV1,
		UnitRegistryVersion: UnitRegistryVersionV1,
		Entities: []KnowledgeEntity{{
			ID: "drag-observation", Type: "measurement", CanonicalName: "Drag coefficient", Aliases: []KnowledgeAlias{},
		}},
		Assertions: []KnowledgeAssertion{{
			ID: "drag-coefficient", SubjectEntityID: "drag-observation", Predicate: "has_value",
			ObjectLiteral: &KnowledgeTypedLiteral{
				LexicalForm: "0.01005273", Datatype: "http://www.w3.org/2001/XMLSchema#decimal",
				Unit: "1", SIValue: "0.01005273", SIUnit: "1",
			},
			Qualifiers: []KnowledgeQualifier{},
			Evidence: []KnowledgeEvidenceRef{{
				Kind: KnowledgeEvidenceEngineering, ArtifactHash: strings.Repeat("a", 64),
				JSONPointer: "/normalized/target/cd", ValueHash: strings.Repeat("b", 64),
			}},
		}},
	}
	if err := patch.ValidateStructure(); err != nil {
		t.Fatalf("dimensionless aerodynamic coefficient was rejected: %v", err)
	}
}

func TestKnowledgePatchUnitOneDoesNotBypassDimensionChecks(t *testing.T) {
	patch := KnowledgePatch{
		SchemaVersion:       KnowledgePatchSchemaV1,
		UnitRegistryVersion: UnitRegistryVersionV1,
		Entities: []KnowledgeEntity{{
			ID: "length-observation", Type: "measurement", CanonicalName: "Chord length", Aliases: []KnowledgeAlias{},
		}},
		Assertions: []KnowledgeAssertion{{
			ID: "chord-length", SubjectEntityID: "length-observation", Predicate: "has_value",
			ObjectLiteral: &KnowledgeTypedLiteral{
				LexicalForm: "1", Datatype: KnowledgeDatatypeLength, Unit: "1", SIValue: "1", SIUnit: "1",
			},
			Qualifiers: []KnowledgeQualifier{},
			Evidence: []KnowledgeEvidenceRef{{
				Kind: KnowledgeEvidenceEngineering, ArtifactHash: strings.Repeat("a", 64),
				JSONPointer: "/spec/chord", ValueHash: strings.Repeat("b", 64),
			}},
		}},
	}
	err := patch.ValidateStructure()
	if err == nil || !strings.Contains(err.Error(), "want length") {
		t.Fatalf("dimensionless unit bypassed a dimensioned value check: %v", err)
	}
}

func TestKnowledgePatchRejectsUnknownUnitRegistry(t *testing.T) {
	patch := KnowledgePatch{
		SchemaVersion: KnowledgePatchSchemaV1, UnitRegistryVersion: "unit_registry_future",
		Entities: []KnowledgeEntity{}, Assertions: []KnowledgeAssertion{},
	}
	if err := patch.ValidateStructure(); err == nil {
		t.Fatal("unknown unit registry was accepted")
	}
}
