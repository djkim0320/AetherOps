package knowledge

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/store"
)

func TestOntologyRowsPropertyKindsAreOrderIndependent(t *testing.T) {
	const prefixes = `
@prefix ex: <https://example.com/schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:Thing a owl:Class .
`
	inputs := []string{
		prefixes + `ex:Thing rdfs:label "Zulu"@en, "가나다"@ko ; rdfs:comment "Second"@en, "첫째"@ko .
ex:value a owl:FunctionalProperty, owl:DatatypeProperty ; rdfs:domain ex:Thing ; rdfs:range xsd:double .`,
		prefixes + `ex:Thing rdfs:comment "첫째"@ko, "Second"@en ; rdfs:label "가나다"@ko, "Zulu"@en .
ex:value rdfs:range xsd:double ; rdfs:domain ex:Thing ; a owl:DatatypeProperty, owl:FunctionalProperty .`,
	}
	var expectedTerms []ontologyTermRow
	var expectedAxioms []ontologyAxiomRow
	for index, input := range inputs {
		parsed, err := ParseOntology("ordered.ttl", "", []byte(input))
		if err != nil {
			t.Fatalf("input %d parse: %v", index, err)
		}
		terms, axioms, err := ontologyRows(parsed.Triples)
		if err != nil {
			t.Fatalf("input %d rows: %v", index, err)
		}
		if index == 0 {
			expectedTerms, expectedAxioms = terms, axioms
			continue
		}
		if !reflect.DeepEqual(terms, expectedTerms) || !reflect.DeepEqual(axioms, expectedAxioms) {
			t.Fatalf("equivalent ontology order changed materialization:\nterms=%+v\nexpected=%+v\naxioms=%+v\nexpected=%+v", terms, expectedTerms, axioms, expectedAxioms)
		}
	}
	found := false
	for _, term := range expectedTerms {
		if term.IRI != "https://example.com/schema#value" {
			continue
		}
		found = true
		if term.Kind != "datatype_property" || !term.Functional || term.ValueKind != "number" {
			t.Fatalf("functional datatype property was misclassified: %+v", term)
		}
	}
	if !found {
		t.Fatal("functional datatype property term is missing")
	}
}

func TestOntologyRowsRejectsConflictingOrAmbiguousPropertyKinds(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "object and datatype", body: `ex:value a owl:ObjectProperty, owl:DatatypeProperty .`},
		{name: "functional without property kind", body: `ex:value a owl:FunctionalProperty .`},
		{name: "class used as property", body: `ex:Thing a owl:Class ; rdfs:domain ex:Thing .`},
		{name: "multiple domains", body: `ex:value a owl:ObjectProperty ; rdfs:domain ex:A, ex:B . ex:A a owl:Class . ex:B a owl:Class .`},
		{name: "multiple ranges", body: `ex:value a owl:ObjectProperty ; rdfs:range ex:A, ex:B . ex:A a owl:Class . ex:B a owl:Class .`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := `
@prefix ex: <https://example.com/schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
` + test.body
			parsed, err := ParseOntology("conflict.ttl", "", []byte(input))
			if err != nil {
				t.Fatal(err)
			}
			if terms, axioms, err := ontologyRows(parsed.Triples); err == nil {
				t.Fatalf("unsupported ontology was materialized: terms=%+v axioms=%+v", terms, axioms)
			}
		})
	}
}

func TestParseSupportedTurtleOntology(t *testing.T) {
	data := []byte(`
@prefix ex: <https://example.com/aether#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Aircraft a owl:Class ; rdfs:label "Aircraft"@en .
ex:hasPart a owl:ObjectProperty ; rdfs:domain ex:Aircraft ; rdfs:range ex:Aircraft .
ex:connectedTo a owl:SymmetricProperty .
`)
	parsed, err := ParseOntology("core.ttl", "", data)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.TripleCount != 6 || len(parsed.CanonicalNQuads) == 0 || parsed.SHA256 == "" {
		t.Fatalf("unexpected parsed ontology: %+v", parsed)
	}
}

func TestOntologyRejectsUnsupportedAxiomAtomically(t *testing.T) {
	data := []byte(`@prefix ex: <https://example.com/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:A a owl:Class . ex:A owl:sameAs ex:B .`)
	if _, err := ParseOntology("bad.ttl", "", data); err == nil {
		t.Fatal("owl:sameAs was accepted")
	}
}

func TestJSONLDRemoteContextRejected(t *testing.T) {
	if _, err := ParseOntology("bad.jsonld", "", []byte(`{"@context":"https://example.com/context","@id":"https://example.com/A"}`)); err == nil {
		t.Fatal("remote context was accepted")
	}
}

func TestParseSupportedJSONLDWithLocalContext(t *testing.T) {
	data := []byte(`{"@context":{"owl":"http://www.w3.org/2002/07/owl#","rdfs":"http://www.w3.org/2000/01/rdf-schema#"},"@id":"urn:aircraft","@type":"owl:Class","rdfs:label":"Aircraft"}`)
	parsed, err := ParseOntology("core.jsonld", "", data)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.TripleCount != 2 || parsed.Format != "jsonld" || len(parsed.CanonicalNQuads) == 0 {
		t.Fatalf("unexpected local JSON-LD ontology: %+v", parsed)
	}
}

func TestJSONLDRejectsUnsupportedAndAmbiguousObjectFormsAtomically(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{
			name: "unsupported node keyword",
			data: `{"@context":{"owl":"http://www.w3.org/2002/07/owl#"},"@id":"urn:a","@type":"owl:Class","@reverse":{"urn:p":{"@id":"urn:b"}}}`,
		},
		{
			name: "unsupported graph wrapper member",
			data: `{"@context":{"owl":"http://www.w3.org/2002/07/owl#"},"@graph":[{"@id":"urn:a","@type":"owl:Class"}],"@id":"urn:named-graph"}`,
		},
		{
			name: "language and datatype literal",
			data: `{"@context":{"owl":"http://www.w3.org/2002/07/owl#","rdfs":"http://www.w3.org/2000/01/rdf-schema#","xsd":"http://www.w3.org/2001/XMLSchema#"},"@id":"urn:a","@type":"owl:Class","rdfs:label":{"@value":"A","@language":"en","@type":"xsd:string"}}`,
		},
		{
			name: "id and value object",
			data: `{"@context":{"owl":"http://www.w3.org/2002/07/owl#","rdfs":"http://www.w3.org/2000/01/rdf-schema#"},"@id":"urn:a","@type":"owl:Class","rdfs:subClassOf":{"@id":"urn:b","@value":"B"}}`,
		},
		{
			name: "unsupported literal keyword",
			data: `{"@context":{"owl":"http://www.w3.org/2002/07/owl#","rdfs":"http://www.w3.org/2000/01/rdf-schema#"},"@id":"urn:a","@type":"owl:Class","rdfs:label":{"@value":"A","@direction":"ltr"}}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if parsed, err := ParseOntology("ambiguous.jsonld", "", []byte(test.data)); err == nil {
				t.Fatalf("ambiguous JSON-LD was partially accepted: %+v", parsed)
			}
		})
	}
}

func TestJSONLDLocalContextResolvesPrefixBeforeDependentTermsDeterministically(t *testing.T) {
	data := []byte(`{"@context":{"Aircraft":{"@id":"ex:Aircraft"},"ex":"https://example.com/schema#","owl":"http://www.w3.org/2002/07/owl#"},"@id":"Aircraft","@type":"owl:Class"}`)
	var expectedHash string
	for attempt := 0; attempt < 100; attempt++ {
		parsed, err := ParseOntology("dependent-context.jsonld", "", data)
		if err != nil {
			t.Fatalf("attempt %d: dependent local context failed: %v", attempt, err)
		}
		if len(parsed.Triples) != 1 || parsed.Triples[0].Subject != "https://example.com/schema#Aircraft" {
			t.Fatalf("attempt %d: dependent term was not expanded: %+v", attempt, parsed.Triples)
		}
		if attempt == 0 {
			expectedHash = parsed.SHA256
		} else if parsed.SHA256 != expectedHash {
			t.Fatalf("attempt %d: canonical hash changed: %s != %s", attempt, parsed.SHA256, expectedHash)
		}
	}
}

func TestTurtleEscapesDecodeWithoutChangingRDFValues(t *testing.T) {
	data := []byte(`
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <https://example.com/schema#> .
<https://example.com/\u0041> a owl:Class ;
  rdfs:label "Line\nTab\tBack\bReturn\rForm\fQuote\" Apostrophe\' Slash\\ Hangul \uD55C Astral \U0001F680" .
ex:Aircraft\~Draft a owl:Class .
`)
	parsed, err := ParseOntology("escapes.ttl", "", data)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.TripleCount != 3 {
		t.Fatalf("triple count=%d", parsed.TripleCount)
	}
	expected := "Line\nTab\tBack\bReturn\rForm\fQuote\" Apostrophe' Slash\\ Hangul \uD55C Astral \U0001F680"
	foundLabel := false
	foundEscapedName := false
	for _, triple := range parsed.Triples {
		if triple.Subject == "https://example.com/schema#Aircraft~Draft" && triple.Predicate == rdfNS+"type" {
			foundEscapedName = true
		}
		if triple.Predicate != rdfsNS+"label" {
			continue
		}
		if triple.Subject != "https://example.com/A" || triple.Object.Value != expected {
			t.Fatalf("Turtle escapes changed RDF value: %+v", triple)
		}
		foundLabel = true
	}
	if !foundLabel || !foundEscapedName {
		t.Fatalf("escaped Turtle label or prefixed name is missing: %+v", parsed.Triples)
	}
}

func TestTurtleRejectsUnsupportedMalformedAndNonScalarEscapes(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{name: "unsupported string escape", data: `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . <urn:a> a owl:Class ; rdfs:label "bad\q" .`},
		{name: "truncated Unicode escape", data: `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . <urn:a> a owl:Class ; rdfs:label "bad\u12" .`},
		{name: "surrogate escape", data: `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . <urn:a> a owl:Class ; rdfs:label "bad\uD800" .`},
		{name: "out of range escape", data: `@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . <urn:a> a owl:Class ; rdfs:label "bad\U00110000" .`},
		{name: "unsupported IRI escape", data: `@prefix owl: <http://www.w3.org/2002/07/owl#> . <https://example.com/\n> a owl:Class .`},
		{name: "unsupported prefixed-name escape", data: `@prefix ex: <https://example.com/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . ex:bad\q a owl:Class .`},
		{name: "unescaped newline", data: "@prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . <urn:a> a owl:Class ; rdfs:label \"bad\nline\" ."},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if parsed, err := ParseOntology("bad-escape.ttl", "", []byte(test.data)); err == nil {
				t.Fatalf("invalid Turtle escape was accepted: %+v", parsed)
			}
		})
	}
}

func TestOntologyRejectsEveryRemoteImportAndContextFormAtomically(t *testing.T) {
	tests := []struct {
		name string
		file string
		data string
	}{
		{
			name: "turtle owl imports", file: "remote.ttl",
			data: `@prefix owl: <http://www.w3.org/2002/07/owl#> . <urn:local> a owl:Ontology ; owl:imports <https://remote.invalid/schema> .`,
		},
		{
			name: "jsonld context import", file: "remote.jsonld",
			data: `{"@context":{"@import":"https://remote.invalid/context","owl":"http://www.w3.org/2002/07/owl#"},"@id":"urn:local","@type":"owl:Ontology"}`,
		},
		{
			name: "jsonld scoped term context", file: "remote.jsonld",
			data: `{"@context":{"ex":{"@id":"https://example.invalid/","@context":"https://remote.invalid/scoped"}},"@id":"urn:local","@type":"http://www.w3.org/2002/07/owl#Class"}`,
		},
		{
			name: "jsonld graph node context", file: "remote.jsonld",
			data: `{"@context":{"owl":"http://www.w3.org/2002/07/owl#"},"@graph":[{"@context":"https://remote.invalid/node","@id":"urn:local","@type":"owl:Class"}]}`,
		},
		{
			name: "rdfxml owl imports", file: "remote.owl",
			data: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Ontology rdf:about="urn:local"><owl:imports rdf:resource="https://remote.invalid/schema"/></owl:Ontology></rdf:RDF>`,
		},
		{
			name: "rdfxml external entity", file: "remote.rdf",
			data: `<?xml version="1.0"?><!DOCTYPE rdf:RDF [<!ENTITY remote SYSTEM "https://remote.invalid/entity">]><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if parsed, err := ParseOntology(test.file, "", []byte(test.data)); err == nil {
				t.Fatalf("remote ontology construct was accepted: %+v", parsed)
			}
		})
	}
}

func TestJSONLDOntologyRejectsTrailingValue(t *testing.T) {
	data := []byte(`{"@context":{"owl":"http://www.w3.org/2002/07/owl#"},"@id":"urn:a","@type":"owl:Class"}{}`)
	if _, err := ParseOntology("multiple.jsonld", "", data); err == nil {
		t.Fatal("multiple JSON-LD values were accepted")
	}
}

func TestParseSupportedRDFXML(t *testing.T) {
	data := []byte(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"><owl:Class rdf:about="https://example.com/A"><rdfs:label>A</rdfs:label></owl:Class></rdf:RDF>`)
	parsed, err := ParseOntology("core.owl", "", data)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.TripleCount != 2 {
		t.Fatalf("triple count=%d", parsed.TripleCount)
	}
}

func TestRDFXMLRejectsConflictingResourceAndLiteralForms(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{
			name: "resource and datatype",
			data: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="urn:a"><rdfs:subClassOf rdf:resource="urn:b" rdf:datatype="http://www.w3.org/2001/XMLSchema#string"/></owl:Class></rdf:RDF>`,
		},
		{
			name: "language and datatype",
			data: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="urn:a"><rdfs:label xml:lang="en" rdf:datatype="http://www.w3.org/2001/XMLSchema#string">A</rdfs:label></owl:Class></rdf:RDF>`,
		},
		{
			name: "resource with text",
			data: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="urn:a"><rdfs:subClassOf rdf:resource="urn:b">unexpected</rdfs:subClassOf></owl:Class></rdf:RDF>`,
		},
		{
			name: "unsupported parse type",
			data: `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="urn:a"><rdfs:label rdf:parseType="Literal">A</rdfs:label></owl:Class></rdf:RDF>`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if parsed, err := ParseOntology("ambiguous.owl", "", []byte(test.data)); err == nil {
				t.Fatalf("ambiguous RDF/XML was partially accepted: %+v", parsed)
			}
		})
	}
}

func TestRDFXMLPreservesLiteralLexicalWhitespace(t *testing.T) {
	data := []byte(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#" xmlns:owl="http://www.w3.org/2002/07/owl#"><owl:Class rdf:about="urn:a"><rdfs:label>  Aircraft  </rdfs:label></owl:Class></rdf:RDF>`)
	parsed, err := ParseOntology("whitespace.owl", "", data)
	if err != nil {
		t.Fatal(err)
	}
	for _, triple := range parsed.Triples {
		if triple.Predicate == rdfsNS+"label" {
			if triple.Object.Value != "  Aircraft  " {
				t.Fatalf("RDF/XML literal lexical whitespace changed: %q", triple.Object.Value)
			}
			return
		}
	}
	t.Fatal("RDF/XML label triple missing")
}

func TestProjectOntologyImportStaysDraftUntilExplicitActivation(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "ontology lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	payload := []byte(`
@prefix project: <urn:aetherops:project:> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
project:Concept a rdfs:Class ; rdfs:label "Concept"@en .
project:relatedTo a owl:ObjectProperty ; rdfs:domain project:Concept ; rdfs:range project:Concept .`)
	importedValue, err := service.ImportOntology(ctx, project.ID, "project-schema.ttl", "text/turtle", payload)
	if err != nil {
		t.Fatal(err)
	}
	imported := importedValue.(map[string]any)
	versionID, _ := imported["ontology_version_id"].(string)
	if versionID == "" || imported["state"] != "draft" || imported["triple_count"] != 5 ||
		imported["term_count"] != 2 || imported["axiom_count"] != 3 {
		t.Fatalf("unexpected ontology preview receipt: %#v", imported)
	}
	graphValue, err := service.Subgraph(ctx, project.ID, "ontology", versionID, "", "", 50, 50)
	if err != nil {
		t.Fatal(err)
	}
	graph := graphValue.(Subgraph)
	if graph.Mode != "ontology" || graph.OntologyID != versionID || graph.State != "draft" ||
		len(graph.Nodes) != 2 || len(graph.Edges) != 2 {
		t.Fatalf("draft ontology graph preview is incomplete: %+v", graph)
	}
	otherProject, err := database.CreateProject(ctx, "ontology isolation")
	if err != nil {
		t.Fatal(err)
	}
	if leaked, err := service.Subgraph(ctx, otherProject.ID, "ontology", versionID, "", "", 50, 50); !errors.Is(err, store.ErrNotFound) || leaked != nil {
		t.Fatalf("project ontology draft leaked across projects: data=%#v err=%v", leaked, err)
	}
	statusValue, err := service.Status(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if status := statusValue.(Status); status.ActiveOntologyVersionID != store.CoreOntologyID || status.State != store.KnowledgeHeadReady {
		t.Fatalf("draft import changed active ontology or graph state: %+v", status)
	}
	if _, err := service.ActivateOntology(ctx, project.ID, versionID); err != nil {
		t.Fatal(err)
	}
	statusValue, err = service.Status(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	status := statusValue.(Status)
	if status.ActiveOntologyVersionID != versionID || status.State != store.KnowledgeHeadStale || status.Ready {
		t.Fatalf("explicit activation did not expose the active draft and fail-closed stale graph: %+v", status)
	}
}

func TestProjectOntologyRejectsImportedCoreTermKeyCollision(t *testing.T) {
	ctx := context.Background()
	database, objects := openKnowledgeServiceTestStorage(t)
	project, err := database.CreateProject(ctx, "ontology collision")
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{DB: database, CAS: objects}
	payload := []byte(`
@prefix ex: <https://example.com/schema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Thing a rdfs:Class .`)
	if result, err := service.ImportOntology(ctx, project.ID, "collision.ttl", "text/turtle", payload); err == nil || result != nil || !strings.Contains(err.Error(), "collides with imported core") {
		t.Fatalf("owner/import term-key collision was accepted: result=%#v err=%v", result, err)
	}
}
