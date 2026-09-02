package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type knowledgeControllerProbe struct {
	SPARQLCalls       int
	ImportCalls       int
	EntityCalls       int
	LastEntityProject string
	EntityValue       any
	SubgraphCalls     int
	LastSubgraphArgs  []string
	PinCalls          int
	LastPinMediaType  string
}

func (*knowledgeControllerProbe) Status(context.Context, string) (any, error) {
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) Search(context.Context, string, string, int) (any, error) {
	return nil, errors.New("unexpected call")
}
func (probe *knowledgeControllerProbe) Subgraph(_ context.Context, projectID, mode, ontologyID, query, entityID string, _, _ int) (any, error) {
	probe.SubgraphCalls++
	probe.LastSubgraphArgs = []string{projectID, mode, ontologyID, query, entityID}
	return map[string]any{"nodes": []any{}, "edges": []any{}}, nil
}
func (probe *knowledgeControllerProbe) Entity(_ context.Context, projectID, _ string) (any, error) {
	probe.EntityCalls++
	probe.LastEntityProject = projectID
	if probe.EntityValue != nil {
		return probe.EntityValue, nil
	}
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) Assertion(context.Context, string, string) (any, error) {
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) Evidence(context.Context, string, string) (any, error) {
	return nil, errors.New("unexpected call")
}
func (probe *knowledgeControllerProbe) SPARQL(context.Context, string, string, int) (any, error) {
	probe.SPARQLCalls++
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) ApplyEdit(context.Context, string, json.RawMessage) (any, error) {
	return nil, errors.New("unexpected call")
}
func (probe *knowledgeControllerProbe) ImportOntology(context.Context, string, string, string, []byte) (any, error) {
	probe.ImportCalls++
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) ActivateOntology(context.Context, string, string) (any, error) {
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) Rebuild(context.Context, string) (any, error) {
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) ExportJSONLD(context.Context, string) ([]byte, error) {
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) Materials(context.Context, string) (any, error) {
	return nil, errors.New("unexpected call")
}
func (probe *knowledgeControllerProbe) PinMaterial(_ context.Context, _, _, mediaType string, _ []byte, _ bool) (any, error) {
	probe.PinCalls++
	probe.LastPinMediaType = mediaType
	return map[string]any{"pinned": true}, nil
}
func (*knowledgeControllerProbe) SetMaterialGraphAdopt(context.Context, string, string, bool) (any, error) {
	return nil, errors.New("unexpected call")
}
func (*knowledgeControllerProbe) DeleteMaterial(context.Context, string, string, string) (any, error) {
	return nil, errors.New("unexpected call")
}

func TestKnowledgeHTTPRejectsOversizedQueryBeforeController(t *testing.T) {
	probe := &knowledgeControllerProbe{}
	server := &Server{Knowledge: probe}
	body, err := json.Marshal(map[string]any{
		"query": strings.Repeat("x", maxSPARQLQueryBytes+1), "max_rows": 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/knowledge/sparql", bytes.NewReader(body))
	response := httptest.NewRecorder()
	server.handleKnowledgePath(response, request, []string{"project", "knowledge", "sparql"})
	if response.Code != http.StatusBadRequest || probe.SPARQLCalls != 0 {
		t.Fatalf("oversized query response=%d calls=%d body=%s", response.Code, probe.SPARQLCalls, response.Body.String())
	}
}

func TestKnowledgeHTTPForwardsOntologySubgraphScopeAndRejectsUnknownMode(t *testing.T) {
	probe := &knowledgeControllerProbe{}
	server := &Server{Knowledge: probe}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/project-a/knowledge/subgraph?mode=ontology&ontology_id=ont-draft&q=wing&entity_id=aircraft", nil)
	response := httptest.NewRecorder()
	server.handleKnowledgePath(response, request, []string{"project-a", "knowledge", "subgraph"})
	if response.Code != http.StatusOK || probe.SubgraphCalls != 1 {
		t.Fatalf("ontology subgraph response=%d calls=%d body=%s", response.Code, probe.SubgraphCalls, response.Body.String())
	}
	want := []string{"project-a", "ontology", "ont-draft", "wing", "aircraft"}
	if strings.Join(probe.LastSubgraphArgs, "|") != strings.Join(want, "|") {
		t.Fatalf("ontology subgraph scope=%v want=%v", probe.LastSubgraphArgs, want)
	}

	probe = &knowledgeControllerProbe{}
	server.Knowledge = probe
	request = httptest.NewRequest(http.MethodGet, "/api/v1/projects/project-a/knowledge/subgraph?mode=global", nil)
	response = httptest.NewRecorder()
	server.handleKnowledgePath(response, request, []string{"project-a", "knowledge", "subgraph"})
	if response.Code != http.StatusBadRequest || probe.SubgraphCalls != 0 {
		t.Fatalf("unknown graph mode reached controller: status=%d calls=%d body=%s", response.Code, probe.SubgraphCalls, response.Body.String())
	}
}

func TestKnowledgeHTTPRejectsSPARQLMutationFederationAndExternalDatasetsBeforeController(t *testing.T) {
	blocked := []string{
		`INSERT DATA { <urn:a> <urn:b> <urn:c> }`,
		`SELECT * WHERE { SERVICE <https://remote.invalid/sparql> { ?s ?p ?o } }`,
		`SELECT * FROM <https://remote.invalid/dataset> WHERE { ?s ?p ?o }`,
		`SELECT * FROM NAMED <https://remote.invalid/dataset> WHERE { GRAPH ?g { ?s ?p ?o } }`,
		`LOAD <https://remote.invalid/dataset>`,
	}
	for _, query := range blocked {
		probe := &knowledgeControllerProbe{}
		server := &Server{Knowledge: probe}
		body, err := json.Marshal(map[string]any{"query": query, "max_rows": 10})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/knowledge/sparql", bytes.NewReader(body))
		response := httptest.NewRecorder()
		server.handleKnowledgePath(response, request, []string{"project", "knowledge", "sparql"})
		if response.Code != http.StatusBadRequest || probe.SPARQLCalls != 0 {
			t.Fatalf("blocked query reached controller: status=%d calls=%d query=%q body=%s",
				response.Code, probe.SPARQLCalls, query, response.Body.String())
		}
	}
}

func TestKnowledgeHTTPKeepsHTMLPayloadAsNonExecutableProjectScopedJSON(t *testing.T) {
	const hostile = `</script><script>alert(document.domain)</script><img src=x onerror=alert(1)>`
	probe := &knowledgeControllerProbe{EntityValue: map[string]any{
		"id": "foreign-looking", "canonical_name": hostile, "description": "javascript:alert(1)",
	}}
	server := &Server{Knowledge: probe}
	request := httptest.NewRequest(http.MethodGet,
		"/api/v1/projects/project-a/knowledge/entities/foreign-looking?project_id=project-b", nil)
	response := httptest.NewRecorder()
	handler := server.securityHeaders(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		server.handleKnowledgePath(writer, request, []string{"project-a", "knowledge", "entities", "foreign-looking"})
	}))
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || probe.EntityCalls != 1 || probe.LastEntityProject != "project-a" {
		t.Fatalf("knowledge route accepted caller project override: status=%d calls=%d project=%q body=%s",
			response.Code, probe.EntityCalls, probe.LastEntityProject, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("hostile payload content type=%q", got)
	}
	if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("hostile knowledge response omitted shell security headers")
	}
	if strings.Contains(response.Body.String(), "<script") || strings.Contains(response.Body.String(), "</script>") || strings.Contains(response.Body.String(), "<img") {
		t.Fatalf("HTML payload was emitted as executable-looking markup: %s", response.Body.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["canonical_name"] != hostile {
		t.Fatalf("JSON escaping changed data rather than containing it: %#v", decoded)
	}
}

func TestKnowledgeHTTPRejectsOversizedOntologyBeforeController(t *testing.T) {
	probe := &knowledgeControllerProbe{}
	server := &Server{Knowledge: probe}
	oversized := bytes.Repeat([]byte{'x'}, maxOntologyImportBytes+1)
	body, err := json.Marshal(map[string]any{
		"filename": "oversized.ttl", "format": "turtle",
		"content_base64": base64.StdEncoding.EncodeToString(oversized),
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/knowledge/ontology/import", bytes.NewReader(body))
	response := httptest.NewRecorder()
	server.handleKnowledgePath(response, request, []string{"project", "knowledge", "ontology", "import"})
	if response.Code != http.StatusBadRequest || probe.ImportCalls != 0 {
		t.Fatalf("oversized ontology response=%d calls=%d body=%s", response.Code, probe.ImportCalls, response.Body.String())
	}
}

func TestDecodeOntologyImportRejectsTrailingJSONValue(t *testing.T) {
	payload := `{"filename":"schema.ttl","format":"turtle","content_base64":"WA=="}{}`
	request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(payload))
	if _, _, _, err := decodeOntologyImport(request); err == nil {
		t.Fatal("ontology import accepted multiple JSON values")
	}
}

func TestKnowledgePinnedTextUploadUsesDeterministicExtensionMediaType(t *testing.T) {
	probe := &knowledgeControllerProbe{}
	server := &Server{Knowledge: probe}
	body, err := json.Marshal(map[string]any{
		"title": "사용자 메모", "filename": "research-notes.md",
		"media_type": "application/octet-stream", "content_base64": "IyDsmqnrgbw=", "graph_adopt": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/knowledge/materials", bytes.NewReader(body))
	response := httptest.NewRecorder()
	server.handleKnowledgePath(response, request, []string{"project", "knowledge", "materials"})
	if response.Code != http.StatusCreated || probe.PinCalls != 1 || probe.LastPinMediaType != "text/markdown; charset=utf-8" {
		t.Fatalf("pinned markdown response=%d calls=%d media=%q body=%s", response.Code, probe.PinCalls, probe.LastPinMediaType, response.Body.String())
	}
}

func TestKnowledgePinnedSU2InputsUseTextMediaType(t *testing.T) {
	for _, filename := range []string{"mesh.su2", "case.cfg"} {
		if got := resolvePinnedMaterialMediaType(filename, "solver input", "application/octet-stream"); got != "text/plain; charset=utf-8" {
			t.Fatalf("%s media type = %q", filename, got)
		}
	}
}

func TestKnowledgeMaterialUploadRejectsTrailingJSONValue(t *testing.T) {
	probe := &knowledgeControllerProbe{}
	server := &Server{Knowledge: probe}
	payload := `{"title":"notes","filename":"notes.txt","content_base64":"YQ==","graph_adopt":false}{}`
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project/knowledge/materials", strings.NewReader(payload))
	response := httptest.NewRecorder()

	server.handleKnowledgePath(response, request, []string{"project", "knowledge", "materials"})

	if response.Code != http.StatusBadRequest || probe.PinCalls != 0 {
		t.Fatalf("trailing JSON response=%d calls=%d body=%s", response.Code, probe.PinCalls, response.Body.String())
	}
}

func TestKnowledgeLookupStorageMissIsStableNotFound(t *testing.T) {
	response := httptest.NewRecorder()
	writeKnowledgeError(response, sql.ErrNoRows)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(strings.ToLower(response.Body.String()), "sql") {
		t.Fatalf("storage implementation leaked in response: %s", response.Body.String())
	}
}
