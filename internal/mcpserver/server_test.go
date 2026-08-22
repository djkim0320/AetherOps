package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/engineering"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/djkim0320/Aether-claw/internal/toolstudio"
)

func TestEngineeringVerificationStageRejectsEveryUnrelatedMCPTool(t *testing.T) {
	ctx := context.Background()
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
	project, err := database.CreateProject(ctx, "verification allowlist")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "question", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	plan, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, "main-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CompleteStage(ctx, plan.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StageCollect, core.EngineeringVerificationOrdinal, "verify-thread", "")
	if err != nil {
		t.Fatal(err)
	}
	identity := map[string]any{"run_id": run.ID, "stage_attempt_id": attempt.ID}
	internalArguments, _ := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"source_url": "https://93.184.216.34/source", "title": "blocked", "media_type": "text/plain", "content_utf8": "blocked",
	})
	if _, err := (&Server{DB: database, CAS: objects}).call(ctx, "evidence_capture", internalArguments); err == nil {
		t.Fatal("verification attempt called evidence_capture")
	}
	engineeringArguments, _ := json.Marshal(identity)
	if _, err := (&Server{DB: database, CAS: objects, Engineering: &engineering.Service{}}).call(ctx, "gmsh_wing_mesh", engineeringArguments); err == nil {
		t.Fatal("verification attempt called another engineering solver")
	}
}

func TestServerPublishesOnlyThroughActiveStageCapability(t *testing.T) {
	ctx := context.Background()
	evidenceOrigin, evidencePolicy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/primary": {Body: []byte("primary source"), MediaType: "text/plain; charset=utf-8"},
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
	project, err := database.CreateProject(ctx, "MCP")
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

	requests := []map[string]any{
		{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}},
		{"jsonrpc": "2.0", "method": "notifications/initialized"},
		{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{}},
		{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": map[string]any{
			"name": "artifact_publish_plan", "arguments": map[string]any{
				"run_id": run.ID, "stage_attempt_id": attempt.ID,
				"content": `{"question":"question"}`, "media_type": "application/json",
			},
		}},
		{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": map[string]any{
			"name": "artifact_publish_plan", "arguments": map[string]any{
				"run_id": run.ID, "stage_attempt_id": "stg_not_active", "content": `{}`,
			},
		}},
	}
	var input strings.Builder
	for _, request := range requests {
		encoded, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		input.Write(encoded)
		input.WriteByte('\n')
	}
	var output bytes.Buffer
	server := &Server{DB: database, CAS: objects, evidencePolicy: evidencePolicy, ToolStudio: &toolstudio.Service{DB: database}}
	if err := server.Serve(ctx, strings.NewReader(input.String()), &output); err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(&output)
	var responses []map[string]any
	for decoder.More() {
		var response map[string]any
		if err := decoder.Decode(&response); err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
	}
	if len(responses) != 4 {
		t.Fatalf("got %d responses, want 4: %s", len(responses), output.String())
	}
	listResult := responses[1]["result"].(map[string]any)
	if tools := listResult["tools"].([]any); len(tools) != 14 {
		t.Fatalf("tool count = %d, want 14", len(tools))
	}
	publishResult := responses[2]["result"].(map[string]any)
	if publishResult["isError"].(bool) {
		t.Fatalf("publish failed: %+v", publishResult)
	}
	deniedResult := responses[3]["result"].(map[string]any)
	if !deniedResult["isError"].(bool) {
		t.Fatal("inactive stage capability unexpectedly published")
	}
	proposalArguments, _ := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID, "kind": "skill", "name": "source-check", "display_name": "Source Check", "description": "Checks source provenance.", "version": "1.0.0",
		"files": []map[string]string{{"path": "SKILL.md", "content": "---\nname: source-check\ndescription: Check source provenance\n---\nUse verified evidence only."}},
	})
	if _, err := server.call(ctx, "tool_package_propose", proposalArguments); err != nil {
		t.Fatal(err)
	}
	packages, err := database.ListToolPackages(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(packages) != 1 || packages[0].State != "pending_approval" {
		t.Fatalf("agent proposal was not held for user approval: %+v", packages)
	}
	approved, err := database.ActivateToolPackage(ctx, project.ID, packages[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	capabilityRaw, _ := json.Marshal(map[string]any{"run_id": run.ID, "stage_attempt_id": attempt.ID})
	catalogResult, err := server.call(ctx, "tool_catalog", capabilityRaw)
	if err != nil {
		t.Fatal(err)
	}
	if catalog := catalogResult.([]map[string]any); len(catalog) != 1 || catalog[0]["kind"] != "skill" {
		t.Fatalf("internal catalog = %+v", catalogResult)
	}
	getRaw, _ := json.Marshal(map[string]any{"run_id": run.ID, "stage_attempt_id": attempt.ID, "package_id": approved.ID})
	getResult, err := server.call(ctx, "tool_get", getRaw)
	if err != nil {
		t.Fatal(err)
	}
	if got := getResult.(core.ToolPackage); len(got.Files) != 1 || got.Files[0].Content == "" {
		t.Fatalf("internal skill readback = %+v", got)
	}
	artifacts, err := database.ListArtifacts(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(artifacts) != 1 || artifacts[0].Kind != "plan" {
		t.Fatalf("unexpected artifacts: %+v", artifacts)
	}
	data, err := objects.ReadVerified(artifacts[0].BlobHash)
	if err != nil || string(data) != `{"question":"question"}` {
		t.Fatalf("CAS readback = %q, %v", data, err)
	}
	evidenceArguments, err := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"source_url": evidenceOrigin + "/primary", "title": "Primary source",
		"publisher": "Example",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.call(ctx, "evidence_capture", evidenceArguments); err != nil {
		t.Fatal(err)
	}
	var eventPayloadRaw string
	if err := database.SQL().QueryRowContext(ctx,
		`SELECT payload_json FROM run_events WHERE run_id=? AND kind='evidence.captured'`, run.ID,
	).Scan(&eventPayloadRaw); err != nil {
		t.Fatal(err)
	}
	var eventPayload map[string]any
	if err := json.Unmarshal([]byte(eventPayloadRaw), &eventPayload); err != nil {
		t.Fatal(err)
	}
	if eventPayload["origin"] != "internal_mcp" {
		t.Fatalf("evidence event does not prove internal MCP origin: %+v", eventPayload)
	}
}

func TestEvidenceCaptureFetchesExactUTF8AndBinaryResponses(t *testing.T) {
	ctx := context.Background()
	fetchedText := "\ud55c\uae00 \uc6d0\ubb38\n{\"value\":1}"
	evidenceOrigin, evidencePolicy := newEvidenceTestOrigin(t, map[string]evidenceTestResponse{
		"/utf8":   {Body: []byte(fetchedText), MediaType: "text/plain; charset=utf-8"},
		"/binary": {Body: []byte{0, 1, 2, 255}, MediaType: "application/octet-stream"},
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
	project, err := database.CreateProject(ctx, "UTF-8 evidence")
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
	server := &Server{DB: database, CAS: objects, evidencePolicy: evidencePolicy}

	var evidenceDefinition map[string]any
	for _, definition := range server.toolDefinitions() {
		if definition["name"] == "evidence_capture" {
			evidenceDefinition = definition
			break
		}
	}
	if evidenceDefinition == nil {
		t.Fatal("evidence_capture definition is missing")
	}
	schema := evidenceDefinition["inputSchema"].(map[string]any)
	properties := schema["properties"].(map[string]any)
	if properties["content_utf8"] != nil || properties["content_base64"] != nil || properties["media_type"] != nil {
		t.Fatalf("evidence schema still permits caller-supplied response data: %+v", properties)
	}
	if _, present := schema["oneOf"]; present {
		t.Fatalf("evidence schema still exposes caller-selected encodings: %+v", schema["oneOf"])
	}

	textBytes := "한글 원문\n{\"value\":1}"
	utf8Arguments, err := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"source_url": "https://93.184.216.34/utf8", "title": "한글 원문",
		"publisher": "Example", "media_type": "text/plain; charset=utf-8",
		"content_utf8": textBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.call(ctx, "evidence_capture", utf8Arguments); err == nil {
		t.Fatal("legacy caller-supplied UTF-8 evidence unexpectedly succeeded")
	}
	utf8Arguments, err = json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"source_url": evidenceOrigin + "/utf8", "title": "UTF-8 source", "publisher": "Example",
	})
	if err != nil {
		t.Fatal(err)
	}
	value, err := server.call(ctx, "evidence_capture", utf8Arguments)
	if err != nil {
		t.Fatal(err)
	}
	evidence := value.(store.Evidence)
	readback, err := objects.ReadVerified(evidence.BlobHash)
	if err != nil || string(readback) != fetchedText {
		t.Fatalf("UTF-8 evidence readback = %q, %v", readback, err)
	}
	if evidence.BlobHash != evidenceTestSHA256([]byte(fetchedText)) || evidence.SourceURL != evidenceOrigin+"/utf8" {
		t.Fatalf("UTF-8 evidence binding = %+v", evidence)
	}

	binaryArguments, err := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"source_url": evidenceOrigin + "/binary", "title": "Binary source", "publisher": "Example",
	})
	if err != nil {
		t.Fatal(err)
	}
	value, err = server.call(ctx, "evidence_capture", binaryArguments)
	if err != nil {
		t.Fatal(err)
	}
	binaryEvidence := value.(store.Evidence)
	readback, err = objects.ReadVerified(binaryEvidence.BlobHash)
	if err != nil || !bytes.Equal(readback, []byte{0, 1, 2, 255}) {
		t.Fatalf("binary evidence readback = %v, %v", readback, err)
	}
	if binaryEvidence.BlobHash != evidenceTestSHA256([]byte{0, 1, 2, 255}) || binaryEvidence.SourceURL != evidenceOrigin+"/binary" {
		t.Fatalf("binary evidence binding = %+v", binaryEvidence)
	}

	invalid := []struct {
		name string
		raw  string
	}{
		{"one-byte caller mismatch", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"` + evidenceOrigin + `/utf8","title":"Mismatch","content_utf8":"x"}`},
		{"shell-wrapper contamination", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"` + evidenceOrigin + `/utf8","title":"Wrapper","content_utf8":"StatusCode: 200\\nContent: source"}`},
		{"caller base64", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"` + evidenceOrigin + `/binary","title":"Base64","content_base64":"AAEC/w=="}`},
		{"caller media type", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"` + evidenceOrigin + `/utf8","title":"Media","media_type":"text/plain"}`},
		{"unknown field", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"` + evidenceOrigin + `/utf8","title":"Unknown","extra":true}`},
		{"empty source URL", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"","title":"Empty"}`},
		{"trailing JSON", `{"run_id":"` + run.ID + `","stage_attempt_id":"` + attempt.ID + `","source_url":"` + evidenceOrigin + `/utf8","title":"Trailing"}{}`},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			var before int
			if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM evidence WHERE run_id=?", run.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if _, err := server.call(ctx, "evidence_capture", json.RawMessage(test.raw)); err == nil {
				t.Fatal("invalid evidence capture unexpectedly succeeded")
			}
			var after int
			if err := database.SQL().QueryRowContext(ctx, "SELECT COUNT(*) FROM evidence WHERE run_id=?", run.ID).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if after != before {
				t.Fatalf("rejected capture changed evidence count from %d to %d", before, after)
			}
		})
	}

	oversized := strings.Repeat("한", maxArtifactBytes/len("한")+1)
	oversizedArguments, err := json.Marshal(map[string]any{
		"run_id": run.ID, "stage_attempt_id": attempt.ID,
		"source_url": "https://93.184.216.34/oversized", "title": "Oversized",
		"media_type": "text/plain", "content_utf8": oversized,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.call(ctx, "evidence_capture", oversizedArguments); err == nil {
		t.Fatal("oversized UTF-8 evidence unexpectedly succeeded")
	}
}

func TestServerRejectsUnlistedTools(t *testing.T) {
	ctx := context.Background()
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
	request := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"filesystem_write","arguments":{"run_id":"x","stage_attempt_id":"y"}}}` + "\n"
	var output bytes.Buffer
	if err := (&Server{DB: database, CAS: objects}).Serve(ctx, strings.NewReader(request), &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `"isError":true`) {
		t.Fatalf("unlisted tool was not rejected: %s", output.String())
	}
}

type recordedKnowledgeCall struct {
	Kind         string
	ProjectID    string
	GenerationID string
	ID           string
	Query        string
}

type recordingKnowledgeReader struct {
	Calls []recordedKnowledgeCall
}

func (reader *recordingKnowledgeReader) SPARQLGeneration(_ context.Context, projectID, generationID, query string, _ int) (any, error) {
	reader.Calls = append(reader.Calls, recordedKnowledgeCall{Kind: "sparql", ProjectID: projectID, GenerationID: generationID, Query: query})
	return map[string]any{"project_id": projectID}, nil
}

func (reader *recordingKnowledgeReader) EntityGeneration(_ context.Context, projectID, generationID, id string) (any, error) {
	reader.Calls = append(reader.Calls, recordedKnowledgeCall{Kind: "entity", ProjectID: projectID, GenerationID: generationID, ID: id})
	return map[string]any{"project_id": projectID, "id": id}, nil
}

func (reader *recordingKnowledgeReader) AssertionGeneration(_ context.Context, projectID, generationID, id string) (any, error) {
	reader.Calls = append(reader.Calls, recordedKnowledgeCall{Kind: "assertion", ProjectID: projectID, GenerationID: generationID, ID: id})
	return map[string]any{"project_id": projectID, "id": id}, nil
}

func TestKnowledgeToolsBindProjectOnlyFromActiveRunStage(t *testing.T) {
	ctx := context.Background()
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
	projectA, err := database.CreateProject(ctx, "project A")
	if err != nil {
		t.Fatal(err)
	}
	projectB, err := database.CreateProject(ctx, "project B")
	if err != nil {
		t.Fatal(err)
	}
	activateMCPTestKnowledge(t, ctx, database, objects, projectA.ID)
	activateMCPTestKnowledge(t, ctx, database, objects, projectB.ID)
	runA, attemptA := activeMCPStage(t, database, projectA.ID, "thread-a")
	runB, attemptB := activeMCPStage(t, database, projectB.ID, "thread-b")
	newHead, err := database.CreateKnowledgeGeneration(ctx, projectA.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	appendMCPTestSnapshot(t, ctx, database, objects, projectA.ID, newHead.ID)
	if _, err := database.TransitionKnowledgeGeneration(ctx, projectA.ID, newHead.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, projectA.ID, newHead.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, projectA.ID, newHead.ID); err != nil {
		t.Fatal(err)
	}
	reader := &recordingKnowledgeReader{}
	server := &Server{DB: database, CAS: objects, Knowledge: reader}

	call := func(name string, arguments map[string]any) error {
		raw, marshalErr := json.Marshal(arguments)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		_, callErr := server.call(ctx, name, raw)
		return callErr
	}
	if err := call("knowledge_sparql", map[string]any{
		"run_id": runA.ID, "stage_attempt_id": attemptA.ID,
		"project_id": projectB.ID, // must be ignored; it is not a capability source.
		"query":      "ASK { ?s ?p ?o }", "max_rows": 25,
	}); err != nil {
		t.Fatal(err)
	}
	if err := call("knowledge_get", map[string]any{
		"run_id": runA.ID, "stage_attempt_id": attemptA.ID,
		"project_id": projectB.ID, "kind": "entity", "id": "foreign-looking-id",
	}); err != nil {
		t.Fatal(err)
	}
	if len(reader.Calls) != 2 || reader.Calls[0].ProjectID != projectA.ID || reader.Calls[1].ProjectID != projectA.ID {
		t.Fatalf("knowledge tool accepted a caller supplied project: %+v", reader.Calls)
	}

	acceptedCalls := len(reader.Calls)
	for _, mismatch := range []map[string]any{
		{"run_id": runB.ID, "stage_attempt_id": attemptA.ID, "kind": "entity", "id": "x"},
		{"run_id": runA.ID, "stage_attempt_id": attemptB.ID, "kind": "assertion", "id": "x"},
	} {
		if err := call("knowledge_get", mismatch); err == nil {
			t.Fatalf("mismatched run/stage capability was accepted: %+v", mismatch)
		}
	}
	if len(reader.Calls) != acceptedCalls {
		t.Fatalf("mismatched capability reached the knowledge service: %+v", reader.Calls[acceptedCalls:])
	}
	for _, call := range reader.Calls {
		if call.ProjectID == projectA.ID && call.GenerationID != runA.KnowledgeGenerationID {
			t.Fatalf("run read active generation %s instead of pinned generation %s: %+v", call.GenerationID, runA.KnowledgeGenerationID, call)
		}
	}

	blockedQueries := []string{
		`INSERT DATA { <urn:a> <urn:b> <urn:c> }`,
		`SELECT * WHERE { SERVICE <https://remote.invalid/sparql> { ?s ?p ?o } }`,
		`SELECT * FROM <https://remote.invalid/dataset> WHERE { ?s ?p ?o }`,
		`SELECT * FROM NAMED <https://remote.invalid/dataset> WHERE { GRAPH ?g { ?s ?p ?o } }`,
		`LOAD <https://remote.invalid/data>`,
		strings.Repeat(" ", 64<<10) + `ASK { ?s ?p ?o }`,
	}
	for _, query := range blockedQueries {
		if err := call("knowledge_sparql", map[string]any{
			"run_id": runA.ID, "stage_attempt_id": attemptA.ID, "query": query, "max_rows": 10,
		}); err == nil {
			t.Fatalf("blocked SPARQL reached the reader: %.80q", query)
		}
	}
	if len(reader.Calls) != acceptedCalls {
		t.Fatalf("blocked SPARQL reached the knowledge service: %+v", reader.Calls[acceptedCalls:])
	}
}

func activeMCPStage(t *testing.T, database *store.DB, projectID, threadID string) (core.Run, core.StageAttempt) {
	t.Helper()
	ctx := context.Background()
	run, err := database.CreateRun(ctx, projectID, "", "question", threadID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(ctx, run.ID, core.StagePlan, 0, threadID, "")
	if err != nil {
		t.Fatal(err)
	}
	return run, attempt
}

func activateMCPTestKnowledge(t *testing.T, ctx context.Context, database *store.DB, objects *cas.Store, projectID string) {
	t.Helper()
	candidate, err := database.CreateKnowledgeGeneration(ctx, projectID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
	if err != nil {
		t.Fatal(err)
	}
	appendMCPTestSnapshot(t, ctx, database, objects, projectID, candidate.ID)
	if _, err := database.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeBuilding, store.KnowledgeValidating, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.TransitionKnowledgeGeneration(ctx, projectID, candidate.ID, store.KnowledgeValidating, store.KnowledgeReady, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ActivateKnowledgeGeneration(ctx, projectID, candidate.ID); err != nil {
		t.Fatal(err)
	}
}

func appendMCPTestSnapshot(t *testing.T, ctx context.Context, database *store.DB, objects *cas.Store, projectID, generationID string) {
	t.Helper()
	snapshot, tripleCount, err := database.KnowledgeNQuads(ctx, projectID, generationID, store.CoreOntologyID)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := objects.PutBytes(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, receipt, "application/n-quads"); err != nil {
		t.Fatal(err)
	}
	if err := database.AppendKnowledgeProjection(ctx, projectID, generationID, store.KnowledgeProjection{
		Snapshots: []store.KnowledgeRDFSnapshotRecord{{
			ID: "krdf_" + receipt.Hash[:32], Format: "n-quads", BlobHash: receipt.Hash,
			DatasetSHA256: receipt.Hash, TripleCount: tripleCount,
		}},
	}); err != nil {
		t.Fatal(err)
	}
}
