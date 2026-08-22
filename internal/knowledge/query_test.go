package knowledge

import (
	"strings"
	"testing"
)

func TestValidateReadOnlySPARQL(t *testing.T) {
	allowed := []string{
		`SELECT ?s WHERE { ?s ?p "DELETE SERVICE" }`,
		`PREFIX ex: <https://example.com/> ASK { ?s ex:service ?o }`,
		`CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
		`DESCRIBE ?s WHERE { ?s ?p ?o }`,
		`SELECT (COUNT(?s) AS ?count) WHERE { ?s ?p ?o . FILTER(?count < 3) }`,
		`SELECT * WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }`,
		`SELECT ?SERVICE WHERE { ?SERVICE <https://example.com/DELETE> ?o }`,
		"# SERVICE <https://remote.invalid/>\nASK { ?s ?p ?o }",
	}
	for _, query := range allowed {
		if err := ValidateReadOnlySPARQL(query); err != nil {
			t.Fatalf("allowed query rejected: %q: %v", query, err)
		}
	}
	blocked := []string{
		`INSERT DATA { <a> <b> <c> }`,
		`ADD <urn:a> TO <urn:b>`,
		`CLEAR ALL`,
		`COPY <urn:a> TO <urn:b>`,
		`CREATE GRAPH <urn:a>`,
		`DROP DEFAULT`,
		`LOAD <https://remote.invalid/data>`,
		`MOVE <urn:a> TO <urn:b>`,
		`SELECT * WHERE { SERVICE <https://example.com/sparql> { ?s ?p ?o } }`,
		`SELECT * FROM <https://example.com/data> WHERE { ?s ?p ?o }`,
		`SELECT * FROM NAMED <https://example.com/data> WHERE { GRAPH ?g { ?s ?p ?o } }`,
		`DELETE WHERE { ?s ?p ?o }`,
		`WITH <urn:a> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }`,
		`USING <https://remote.invalid/data> SELECT * WHERE { ?s ?p ?o }`,
		`BIND(1 AS ?x) SELECT * WHERE { ?s ?p ?o }`,
	}
	for _, query := range blocked {
		if err := ValidateReadOnlySPARQL(query); err == nil {
			t.Fatalf("blocked query accepted: %q", query)
		}
	}
}

func TestReadOnlySPARQLQueryFormUsesTopLevelForm(t *testing.T) {
	form, err := ReadOnlySPARQLQueryForm(`PREFIX ex: <urn:example:> SELECT ?s WHERE { { SELECT ?s WHERE { ?s ex:p ?o } } }`)
	if err != nil {
		t.Fatal(err)
	}
	if form != "SELECT" {
		t.Fatalf("query form = %q, want SELECT", form)
	}
}

func TestValidateReadOnlySPARQLMeasuresCompleteUTF8Request(t *testing.T) {
	query := `SELECT * WHERE { ?s ?p ?o } #` + strings.Repeat("한", MaxSPARQLQueryBytes)
	if err := ValidateReadOnlySPARQL(query); err == nil {
		t.Fatal("oversized UTF-8 query was accepted")
	}
	padding := strings.Repeat(" ", MaxSPARQLQueryBytes) + `ASK { ?s ?p ?o }`
	if err := ValidateReadOnlySPARQL(padding); err == nil {
		t.Fatal("oversized leading padding bypassed the query limit")
	}
}
