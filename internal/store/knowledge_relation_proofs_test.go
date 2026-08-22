package store

import (
	"strings"
	"testing"
)

func TestRelationProofValidationRejectsWrongInverseConclusion(t *testing.T) {
	premise := storedRelationAssertion{id: "premise", subject: "left", predicate: "forward", object: "right", qualifiers: "{}", polarity: "affirmed", status: "accepted", confidence: 1}
	wrong := storedRelationAssertion{id: "wrong", subject: "left", predicate: "reverse", object: "right", qualifiers: "{}", polarity: "affirmed", status: "accepted", confidence: 1}
	err := validateStoredRelationInferences(
		map[string]storedRelationInference{"inference": {id: "inference", conclusionID: wrong.id, ontologyID: "ontology", axiomID: "inverse", status: "accepted"}},
		map[string]string{wrong.id: "inference"},
		map[string][]storedRelationProof{"inference": {{ordinal: 0, premiseID: premise.id}}},
		map[string]storedRelationAxiom{"ontology\x00inverse": {kind: "inverse_of", subject: "forward", object: "reverse"}},
		map[string]storedRelationAssertion{premise.id: premise, wrong.id: wrong},
	)
	if err == nil || !strings.Contains(err.Error(), "does not reverse") {
		t.Fatalf("wrong inverse conclusion was accepted: %v", err)
	}
}

func TestRelationProofValidationRejectsCycle(t *testing.T) {
	left := storedRelationAssertion{id: "left", subject: "entity", predicate: "q", literal: `{"lexical_form":"1"}`, qualifiers: "{}", polarity: "affirmed", status: "accepted", confidence: 1}
	right := storedRelationAssertion{id: "right", subject: "entity", predicate: "p", literal: `{"lexical_form":"1"}`, qualifiers: "{}", polarity: "affirmed", status: "accepted", confidence: 1}
	err := validateStoredRelationInferences(
		map[string]storedRelationInference{
			"infer-left":  {id: "infer-left", conclusionID: left.id, ontologyID: "ontology", axiomID: "p-to-q", status: "accepted"},
			"infer-right": {id: "infer-right", conclusionID: right.id, ontologyID: "ontology", axiomID: "q-to-p", status: "accepted"},
		},
		map[string]string{left.id: "infer-left", right.id: "infer-right"},
		map[string][]storedRelationProof{
			"infer-left":  {{ordinal: 0, premiseID: right.id}},
			"infer-right": {{ordinal: 0, premiseID: left.id}},
		},
		map[string]storedRelationAxiom{
			"ontology\x00p-to-q": {kind: "subproperty_of", subject: "p", object: "q"},
			"ontology\x00q-to-p": {kind: "subproperty_of", subject: "q", object: "p"},
		},
		map[string]storedRelationAssertion{left.id: left, right.id: right},
	)
	if err == nil || !strings.Contains(err.Error(), "proof cycle") {
		t.Fatalf("cyclic relation proof was accepted: %v", err)
	}
}

func TestRelationProofValidationComparesValiditySemantically(t *testing.T) {
	premise := storedRelationAssertion{
		id: "premise", subject: "left", predicate: "specific", object: "right",
		qualifiers: "{}", polarity: "affirmed", status: "accepted", confidence: 1,
		validFrom: "2026-08-09T12:34:56.1+09:00", validTo: "2026-08-10T12:34:56+09:00",
	}
	conclusion := premise
	conclusion.id, conclusion.predicate = "conclusion", "general"
	conclusion.validFrom = "2026-08-09T03:34:56.100000000Z"
	conclusion.validTo = "2026-08-10T03:34:56.000000000Z"
	err := validateStoredRelationInferences(
		map[string]storedRelationInference{"inference": {id: "inference", conclusionID: conclusion.id, ontologyID: "ontology", axiomID: "subproperty", status: "accepted"}},
		map[string]string{conclusion.id: "inference"},
		map[string][]storedRelationProof{"inference": {{ordinal: 0, premiseID: premise.id}}},
		map[string]storedRelationAxiom{"ontology\x00subproperty": {kind: "subproperty_of", subject: "specific", object: "general"}},
		map[string]storedRelationAssertion{premise.id: premise, conclusion.id: conclusion},
	)
	if err != nil {
		t.Fatalf("semantically equal validity boundaries were rejected: %v", err)
	}
}

func TestRelationIntervalIntersectionUsesSemanticInclusiveTime(t *testing.T) {
	from, to, ok, err := relationIntervalIntersection(
		"2026-08-09T12:00:00+09:00", "",
		"", "2026-08-09T03:00:00.000000000Z",
	)
	if err != nil || !ok {
		t.Fatalf("inclusive intersection failed: %q/%q %v %v", from, to, ok, err)
	}
	const boundary = "2026-08-09T03:00:00.000000000Z"
	if from != boundary || to != boundary {
		t.Fatalf("inclusive intersection = %q/%q, want %q/%q", from, to, boundary, boundary)
	}
	if _, _, ok, err := relationIntervalIntersection(
		"2026-08-09T12:00:00.000000001+09:00", "",
		"", "2026-08-09T03:00:00Z",
	); err != nil || ok {
		t.Fatalf("disjoint interval = ok:%v err:%v", ok, err)
	}
	if _, _, _, err := relationIntervalIntersection("not-rfc3339", "", "", ""); err == nil {
		t.Fatal("invalid relation interval was accepted")
	}
	if _, _, _, err := relationIntervalIntersection(
		"2026-08-09T04:00:00Z", "2026-08-09T03:00:00Z", "", "",
	); err == nil {
		t.Fatal("reversed relation interval was accepted")
	}
}
