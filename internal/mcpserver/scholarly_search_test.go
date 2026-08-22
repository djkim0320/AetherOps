package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/browser"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const scholarlyCrossrefFixture = `{
  "message": {"items": [{
    "DOI": "10.1234/SHARED", "title": ["Shared Wing Study"],
    "author": [{"given": "Ada", "family": "Lovelace"}],
    "publisher": "Example Press", "published": {"date-parts": [[2025, 2, 3]]},
    "URL": "https://doi.org/10.1234/SHARED", "container-title": ["Flight Journal"],
    "link": [{"URL": "https://papers.example/shared.pdf", "content-type": "application/pdf"}],
    "is-referenced-by-count": 12
  }]}
}`

const scholarlyArXivFixture = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>https://arxiv.org/abs/2401.00001v2</id>
    <title>Open Rotor Methods</title>
    <summary>A reproducible method.</summary>
    <published>2024-01-02T03:04:05Z</published>
    <author><name>Grace Hopper</name></author>
    <link href="https://arxiv.org/pdf/2401.00001v2" rel="related" type="application/pdf" title="pdf"/>
  </entry>
</feed>`

const scholarlyEuropePMCFixture = `{
  "resultList": {"result": [{
    "id": "12345678", "source": "MED", "pmid": "12345678", "pmcid": "PMC1234567",
    "doi": "10.1234/shared", "title": "Shared Wing Study", "authorString": "Ada Lovelace; Alan Turing",
    "journalTitle": "Flight Journal", "pubYear": "2025", "firstPublicationDate": "2025-02-03",
    "abstractText": "Repository abstract.", "isOpenAccess": "Y", "inPMC": "Y", "citedByCount": 42,
    "fullTextUrlList": {"fullTextUrl": [{
      "availability": "Open access", "documentStyle": "pdf", "url": "https://pmc.example/shared.pdf"
    }]}
  }]}
}`

func TestScholarlySearchMergesRealProviderResponseFormats(t *testing.T) {
	origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/crossref":  {Body: []byte(scholarlyCrossrefFixture), MediaType: "application/json"},
		"/arxiv":     {Body: []byte(scholarlyArXivFixture), MediaType: "application/atom+xml"},
		"/europepmc": {Body: []byte(scholarlyEuropePMCFixture), MediaType: "application/json"},
	})
	response, err := searchScholarly(context.Background(), policy, scholarlyEndpoints{
		Crossref: origin + "/crossref", ArXiv: origin + "/arxiv", EuropePMC: origin + "/europepmc",
	}, "  wing   aerodynamics  ", 10)
	if err != nil {
		t.Fatal(err)
	}
	if response.Query != "wing aerodynamics" || len(response.Providers) != 3 {
		t.Fatalf("search response metadata = %#v", response)
	}
	for _, provider := range response.Providers {
		if provider.Status != "ok" {
			t.Fatalf("provider report = %#v", provider)
		}
	}
	if len(response.Results) != 2 {
		t.Fatalf("merged result count = %d, want 2: %#v", len(response.Results), response.Results)
	}
	var shared, arxiv scholarlyCandidate
	for _, candidate := range response.Results {
		switch candidate.ID {
		case "doi:10.1234/shared":
			shared = candidate
		case "arxiv:2401.00001":
			arxiv = candidate
		}
	}
	if shared.PMCID != "PMC1234567" || shared.CitationCount != 42 || !shared.OpenAccess {
		t.Fatalf("merged DOI candidate = %#v", shared)
	}
	if len(shared.Providers) != 2 || shared.FullTextURL == "" {
		t.Fatalf("merged provenance/full text = %#v", shared)
	}
	if arxiv.ArXivID != "2401.00001" || arxiv.FullTextURL == "" || !arxiv.OpenAccess {
		t.Fatalf("arXiv candidate = %#v", arxiv)
	}
}

func TestScholarlySearchReportsPartialFailureAndFailsWhenAllProvidersFail(t *testing.T) {
	emptyArXiv := `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`
	emptyEuropePMC := `{"resultList":{"result":[]}}`
	origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/crossref":  {Status: http.StatusServiceUnavailable, Body: []byte("unavailable"), MediaType: "application/json"},
		"/arxiv":     {Body: []byte(emptyArXiv), MediaType: "application/atom+xml"},
		"/europepmc": {Body: []byte(emptyEuropePMC), MediaType: "application/json"},
	})
	response, err := searchScholarly(context.Background(), policy, scholarlyEndpoints{
		Crossref: origin + "/crossref", ArXiv: origin + "/arxiv", EuropePMC: origin + "/europepmc",
	}, "boundary layers", 5)
	if err != nil {
		t.Fatal(err)
	}
	if response.Providers[0].Provider != "crossref" || response.Providers[0].Status != "error" || response.Providers[0].Error == "" {
		t.Fatalf("partial failure was not explicit: %#v", response.Providers)
	}

	failedOrigin, failedPolicy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/crossref":  {Status: http.StatusBadGateway, Body: []byte("failed"), MediaType: "application/json"},
		"/arxiv":     {Status: http.StatusBadGateway, Body: []byte("failed"), MediaType: "application/xml"},
		"/europepmc": {Status: http.StatusBadGateway, Body: []byte("failed"), MediaType: "application/json"},
	})
	_, err = searchScholarly(context.Background(), failedPolicy, scholarlyEndpoints{
		Crossref: failedOrigin + "/crossref", ArXiv: failedOrigin + "/arxiv", EuropePMC: failedOrigin + "/europepmc",
	}, "boundary layers", 5)
	if err == nil || !strings.Contains(err.Error(), "all scholarly providers failed") {
		t.Fatalf("all-provider failure error = %v", err)
	}
}

func TestScholarlySearchMCPRequiresActiveStageAndStrictArguments(t *testing.T) {
	ctx := context.Background()
	origin, policy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/crossref":  {Body: []byte(scholarlyCrossrefFixture), MediaType: "application/json"},
		"/arxiv":     {Body: []byte(scholarlyArXivFixture), MediaType: "application/atom+xml"},
		"/europepmc": {Body: []byte(scholarlyEuropePMCFixture), MediaType: "application/json"},
	})
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "scholarly MCP")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "question", "thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, "thread", "")
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		DB: database, CAS: objects, evidencePolicy: policy,
		scholarEndpoints: scholarlyEndpoints{
			Crossref: origin + "/crossref", ArXiv: origin + "/arxiv", EuropePMC: origin + "/europepmc",
		},
	}
	arguments, err := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID, "query": "wing", "limit": 4,
	})
	if err != nil {
		t.Fatal(err)
	}
	value, err := server.call(ctx, "scholarly_search", arguments)
	if err != nil {
		t.Fatal(err)
	}
	if response, ok := value.(scholarlySearchResponse); !ok || len(response.Results) != 2 {
		t.Fatalf("MCP scholarly search result = %#v", value)
	}
	unknownArguments, _ := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID, "query": "wing", "content_utf8": "not allowed",
	})
	if _, err := server.call(ctx, "scholarly_search", unknownArguments); err == nil {
		t.Fatal("scholarly_search accepted an unknown argument")
	}
	if err := database.CompleteStage(ctx, attempt.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := server.call(ctx, "scholarly_search", arguments); err == nil {
		t.Fatal("scholarly_search accepted an inactive stage capability")
	}
}

func TestScholarlySearchValidatesQueryAndLimitBeforeNetwork(t *testing.T) {
	if _, err := searchScholarly(context.Background(), browser.Policy{}, scholarlyEndpoints{}, " ", 1); err == nil {
		t.Fatal("empty scholarly query was accepted")
	}
	if _, err := searchScholarly(context.Background(), browser.Policy{}, scholarlyEndpoints{}, "query", maxScholarlyLimit+1); err == nil {
		t.Fatal("oversized scholarly result limit was accepted")
	}
}
