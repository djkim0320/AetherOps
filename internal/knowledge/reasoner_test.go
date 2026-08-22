package knowledge

import (
	"testing"
	"time"
)

func TestReasonerProducesProofCarryingSubsetInferences(t *testing.T) {
	rules := CompileOntologyRules([]RDFTriple{
		{Subject: "urn:Child", Predicate: rdfsNS + "subClassOf", Object: RDFObject{IRI: "urn:Parent"}},
		{Subject: "urn:partOf", Predicate: rdfNS + "type", Object: RDFObject{IRI: owlNS + "TransitiveProperty"}},
		{Subject: "urn:hasPart", Predicate: owlNS + "inverseOf", Object: RDFObject{IRI: "urn:partOf"}},
	})
	asserted := []Statement{{ID: "a1", Subject: "urn:x", Predicate: rdfNS + "type", Object: RDFObject{IRI: "urn:Child"}}, {ID: "a2", Subject: "urn:x", Predicate: "urn:partOf", Object: RDFObject{IRI: "urn:y"}}, {ID: "a3", Subject: "urn:y", Predicate: "urn:partOf", Object: RDFObject{IRI: "urn:z"}}}
	derived, err := Infer(asserted, rules, 100)
	if err != nil {
		t.Fatal(err)
	}
	foundTransitive := false
	for _, item := range derived {
		if item.Statement.Subject == "urn:x" && item.Statement.Predicate == "urn:partOf" && item.Statement.Object.IRI == "urn:z" {
			foundTransitive = true
			if item.RuleID != "owl.TransitiveProperty" || len(item.ParentIDs) != 2 {
				t.Fatalf("missing proof: %+v", item)
			}
		}
	}
	if !foundTransitive {
		t.Fatalf("transitive inference missing: %+v", derived)
	}
}

func TestFunctionalConflictUsesQualifiersAndTimeOverlap(t *testing.T) {
	rules := OntologyRules{Functional: map[string]bool{"urn:mass": true}}
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	later := end.Add(time.Hour)
	statements := []Statement{{ID: "a", Subject: "urn:wing", Predicate: "urn:mass", Object: RDFObject{Value: "10"}, Qualifiers: map[string]RDFObject{"urn:condition": {Value: "dry"}}, ValidFrom: &start, ValidTo: &end}, {ID: "b", Subject: "urn:wing", Predicate: "urn:mass", Object: RDFObject{Value: "11"}, Qualifiers: map[string]RDFObject{"urn:condition": {Value: "dry"}}, ValidFrom: &start, ValidTo: &end}, {ID: "c", Subject: "urn:wing", Predicate: "urn:mass", Object: RDFObject{Value: "12"}, Qualifiers: map[string]RDFObject{"urn:condition": {Value: "wet"}}, ValidFrom: &start, ValidTo: &end}, {ID: "d", Subject: "urn:wing", Predicate: "urn:mass", Object: RDFObject{Value: "13"}, Qualifiers: map[string]RDFObject{"urn:condition": {Value: "dry"}}, ValidFrom: &later}}
	conflicts := DetectFunctionalConflicts(statements, rules)
	if len(conflicts) != 1 || conflicts[0].LeftID != "a" || conflicts[0].RightID != "b" {
		t.Fatalf("unexpected conflicts: %+v", conflicts)
	}
}
