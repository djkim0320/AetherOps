//go:build windows && amd64

package engineering

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/store"
)

type receiptServiceSecurityFixture struct {
	service  *Service
	database *store.DB
	objects  *cas.Store
	run      core.Run
	attempt  core.StageAttempt
}

func newReceiptServiceSecurityFixture(t *testing.T) receiptServiceSecurityFixture {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	database, err := store.Open(ctx, filepath.Join(root, "aetherops.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	objects, err := cas.Open(filepath.Join(root, "objects"))
	if err != nil {
		t.Fatal(err)
	}
	runtimeRoot := filepath.Join(root, "runtime")
	if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	fakeExecutable := func(name string) string {
		t.Helper()
		path := filepath.Join(runtimeRoot, name)
		if err := os.WriteFile(path, []byte("security-fixture "+name), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	paths := managedruntime.ProcessPaths{
		OpenVSPScriptExecutable: fakeExecutable("vspscript.exe"),
		VSPAEROExecutable:       fakeExecutable("vspaero.exe"),
		GmshExecutable:          fakeExecutable("gmsh.exe"),
		XFOILExecutable:         fakeExecutable("xfoil.exe"),
		SU2CFDExecutable:        fakeExecutable("SU2_CFD.exe"),
	}
	service, err := New(Config{
		DB: database, CAS: objects,
		WorkspaceRoot: filepath.Join(root, "workspace"), Runtime: paths,
	})
	if err != nil {
		t.Fatal(err)
	}
	project, err := database.CreateProject(ctx, "engineering get provenance")
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "receipt readback", "main-thread")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	run, err = database.TransitionRun(ctx, run.ID, run.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	attempt, err := database.BeginStage(
		ctx, run.ID, core.StageCollect, 0, "collector-thread", "collector-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	return receiptServiceSecurityFixture{
		service: service, database: database, objects: objects, run: run, attempt: attempt,
	}
}

func approveReceiptServiceJob(
	t *testing.T,
	fixture receiptServiceSecurityFixture,
	attempt core.StageAttempt,
	operation string,
	arguments any,
) string {
	t.Helper()
	encoded, err := canonicalJSON(arguments)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	hash := hex.EncodeToString(digest[:])
	approval, err := fixture.database.CreateApproval(context.Background(), core.Approval{
		RunID: fixture.run.ID, StageAttemptID: attempt.ID,
		ThreadID: attempt.CodexThreadID, TurnID: "collector-turn", ItemID: operation,
		Kind: "item/mcpToolCall/requestApproval", Summary: "receipt security fixture",
		Server: "aetherops_engineering", Tool: operation,
		ArgumentsJSON: string(encoded), ArgumentsSHA256: hash,
		Risk: "external_side_effect", ExternalSideEffect: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.database.DecideApproval(context.Background(), approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	return hash
}

func executeReceiptServiceJob(
	t *testing.T,
	fixture receiptServiceSecurityFixture,
) (JobResult, any, *int) {
	t.Helper()
	arguments := struct {
		RunID          string  `json:"run_id"`
		StageAttemptID string  `json:"stage_attempt_id"`
		Mach           float64 `json:"mach"`
	}{RunID: fixture.run.ID, StageAttemptID: fixture.attempt.ID, Mach: 0.1}
	approveReceiptServiceJob(t, fixture, fixture.attempt, "xfoil_polar", arguments)
	executions := new(int)
	result, err := fixture.service.execute(
		context.Background(), fixture.run.ID, fixture.attempt.ID,
		"xfoil_polar", "xfoil", managedruntime.PinnedXFOILVersion, arguments,
		func(_ context.Context, directory string) (operationOutput, error) {
			*executions++
			path := filepath.Join(directory, "normalized.json")
			if err := os.WriteFile(path, []byte(`{"cl":0.8,"cd":0.01}`), 0o600); err != nil {
				return operationOutput{}, err
			}
			largeSamples := make([]map[string]any, 2000)
			for index := range largeSamples {
				largeSamples[index] = map[string]any{"alpha": index, "cl": 0.8, "cd": 0.01, "cm": -0.1}
			}
			return operationOutput{
				metrics: map[string]any{
					"samples": largeSamples, "points": largeSamples,
					"sample_count": 2000, "requested_point_count": 2000,
					"nonconverged_point_count": 0, "missing_point_count": 0,
					"optimization": map[string]any{
						"objective": "minimize_cd_at_target_cl", "target_cl": 0.8,
						"minimum_cm": -0.2, "target_reached": true,
						"target_metrics": map[string]any{
							"alpha_deg": 3.5, "cl": 0.8, "cd": 0.01, "cm_c4": -0.1,
							"flap_deflection_deg": 15.0, "constraint_satisfied": true,
						},
					},
				},
				files: []outputFile{{
					path: path, role: "normalized", name: "normalized.json", mediaType: "application/json",
				}},
				exitCodes: []int{0}, numericallyValid: true,
			}, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return result, arguments, executions
}

func TestEngineeringGetPreservesFreshCachedProvenanceAndRunScope(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	ctx := context.Background()
	fresh, arguments, executions := executeReceiptServiceJob(t, fixture)
	expectedArguments, err := canonicalJSON(arguments)
	if err != nil {
		t.Fatal(err)
	}
	assertArguments := func(label string, result JobResult) {
		t.Helper()
		if result.ReceiptArtifactID == "" || result.ReceiptArtifactID != result.Provenance.ID {
			t.Fatalf("%s receipt artifact id/provenance = %q/%q", label,
				result.ReceiptArtifactID, result.Provenance.ID)
		}
		if len(result.Arguments) == 0 || !bytes.Equal(result.Arguments, expectedArguments) {
			t.Fatalf("%s canonical arguments = %s, want %s", label, result.Arguments, expectedArguments)
		}
		if len(result.EvidenceHandles) == 0 {
			t.Fatalf("%s omitted CAS-derived evidence handles", label)
		}
		var argumentHandle, metricHandle *EvidenceHandle
		for index := range result.EvidenceHandles {
			handle := &result.EvidenceHandles[index]
			if handle.JSONPointer == "/" || strings.Contains(handle.JSONPointer, "/samples") ||
				strings.Contains(handle.JSONPointer, "/points") ||
				strings.Contains(handle.JSONPointer, "/artifacts") {
				t.Fatalf("%s exposed an unbounded/administrative evidence handle: %+v", label, handle)
			}
			switch handle.JSONPointer {
			case "/spec/arguments/mach":
				argumentHandle = handle
			case "/metrics/optimization/target_metrics/cd":
				metricHandle = handle
			}
		}
		for pointer, handle := range map[string]*EvidenceHandle{
			"/spec/arguments/mach": argumentHandle, "/metrics/optimization/target_metrics/cd": metricHandle,
		} {
			if handle == nil || handle.Kind != core.KnowledgeEvidenceEngineering ||
				handle.ArtifactHash != result.Provenance.BlobHash || len(handle.ValueHash) != 64 {
				t.Fatalf("%s invalid evidence handle %s: %+v", label, pointer, handle)
			}
		}
		machDigest := sha256.Sum256([]byte("0.1"))
		cdDigest := sha256.Sum256([]byte("0.01"))
		if argumentHandle.ValueHash != hex.EncodeToString(machDigest[:]) ||
			metricHandle.ValueHash != hex.EncodeToString(cdDigest[:]) {
			t.Fatalf("%s evidence value hashes do not match exact JSON values: mach=%s cd=%s",
				label, argumentHandle.ValueHash, metricHandle.ValueHash)
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if len(encoded) > 16*1024 || bytes.Contains(encoded, []byte(`"samples"`)) ||
			bytes.Contains(encoded, []byte(`"points"`)) {
			t.Fatalf("%s model-facing result is not bounded: %d bytes", label, len(encoded))
		}
		var wire map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &wire); err != nil {
			t.Fatal(err)
		}
		if _, exposed := wire["provenance"]; exposed {
			t.Fatalf("%s exposed internal provenance in model-facing JSON", label)
		}
		var receiptArtifactID string
		if err := json.Unmarshal(wire["receipt_artifact_id"], &receiptArtifactID); err != nil ||
			receiptArtifactID != result.ReceiptArtifactID {
			t.Fatalf("%s wire receipt artifact id = %q err=%v", label, receiptArtifactID, err)
		}
		var artifacts []map[string]json.RawMessage
		if err := json.Unmarshal(wire["artifacts"], &artifacts); err != nil || len(artifacts) == 0 {
			t.Fatalf("%s wire artifacts are unavailable: count=%d err=%v", label, len(artifacts), err)
		}
		for _, artifact := range artifacts {
			if _, legacy := artifact["sha256"]; legacy {
				t.Fatalf("%s exposed ambiguous artifact sha256 field", label)
			}
			if _, ok := artifact["cas_blob_sha256"]; !ok {
				t.Fatalf("%s artifact omits cas_blob_sha256: %+v", label, artifact)
			}
		}
	}
	if fresh.ReusedResult || !fresh.Executed || fresh.Provenance.ID == "" {
		t.Fatalf("fresh result flags/provenance = %+v", fresh)
	}
	assertArguments("fresh result", fresh)

	cached, err := fixture.service.execute(
		ctx, fixture.run.ID, fixture.attempt.ID,
		"xfoil_polar", "xfoil", managedruntime.PinnedXFOILVersion, arguments,
		func(context.Context, string) (operationOutput, error) {
			*executions++
			return operationOutput{}, errors.New("completed solver result was re-executed")
		},
	)
	if err != nil {
		t.Fatalf("cached execution readback: %v", err)
	}
	if !cached.ReusedResult || cached.Provenance != fresh.Provenance ||
		cached.ReceiptArtifactID != fresh.ReceiptArtifactID || *executions != 1 {
		t.Fatalf("cached result changed provenance or replayed solver: fresh=%+v cached=%+v executions=%d",
			fresh.Provenance, cached.Provenance, *executions)
	}
	if !reflect.DeepEqual(cached.EvidenceHandles, fresh.EvidenceHandles) ||
		!reflect.DeepEqual(cached.SummaryMetrics, fresh.SummaryMetrics) {
		t.Fatal("cached result changed the immutable model evidence view")
	}
	assertArguments("cached result", cached)

	readback, err := fixture.service.EngineeringGet(ctx, fixture.run.ID, fixture.attempt.ID, fresh.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if !readback.ReusedResult || readback.Provenance != fresh.Provenance ||
		readback.ReceiptArtifactID != fresh.ReceiptArtifactID {
		t.Fatalf("engineering_get changed immutable provenance: %+v", readback)
	}
	assertArguments("engineering_get readback", readback)

	// Independent verification runs in a distinct collector attempt and must be
	// able to read a screening receipt from an earlier attempt in the same run.
	verificationAttempt, err := fixture.database.BeginStage(
		ctx, fixture.run.ID, core.StageCollect, core.EngineeringVerificationOrdinal,
		"verification-thread", "verification-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	crossAttempt, err := fixture.service.EngineeringGet(
		ctx, fixture.run.ID, verificationAttempt.ID, fresh.JobID,
	)
	if err != nil || crossAttempt.Provenance != fresh.Provenance ||
		crossAttempt.ReceiptArtifactID != fresh.ReceiptArtifactID {
		t.Fatalf("same-run independent attempt could not read screening receipt: result=%+v err=%v", crossAttempt, err)
	}
	assertArguments("cross-attempt engineering_get readback", crossAttempt)

	otherRun, err := fixture.database.CreateRun(
		ctx, fixture.run.ProjectID, "", "cross-run receipt probe", "main-thread",
	)
	if err != nil {
		t.Fatal(err)
	}
	otherRun, err = fixture.database.TransitionRun(ctx, otherRun.ID, otherRun.Revision, core.RunPlanning, "")
	if err != nil {
		t.Fatal(err)
	}
	otherRun, err = fixture.database.TransitionRun(ctx, otherRun.ID, otherRun.Revision, core.RunCollecting, "")
	if err != nil {
		t.Fatal(err)
	}
	otherAttempt, err := fixture.database.BeginStage(
		ctx, otherRun.ID, core.StageCollect, 0, "other-thread", "other-turn",
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.EngineeringGet(ctx, otherRun.ID, otherAttempt.ID, fresh.JobID); err == nil {
		t.Fatal("engineering_get disclosed a receipt across run boundaries")
	}
}

func TestEngineeringGetRejectsReceiptJobSpecMismatch(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	ctx := context.Background()
	fresh, _, _ := executeReceiptServiceJob(t, fixture)
	job, err := fixture.database.EngineeringJob(ctx, fresh.JobID)
	if err != nil {
		t.Fatal(err)
	}
	var changedSpec map[string]any
	if err := json.Unmarshal([]byte(job.SpecJSON), &changedSpec); err != nil {
		t.Fatal(err)
	}
	changedSpec["arguments"] = map[string]any{
		"run_id":           fixture.run.ID,
		"stage_attempt_id": fixture.attempt.ID,
		"mach":             0.2,
	}
	encoded, err := json.Marshal(changedSpec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.database.SQL().ExecContext(
		ctx, `UPDATE engineering_jobs SET spec_json=? WHERE id=?`, string(encoded), fresh.JobID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.EngineeringGet(
		ctx, fixture.run.ID, fixture.attempt.ID, fresh.JobID,
	); err == nil {
		t.Fatal("engineering_get accepted a receipt whose canonical spec differed from the immutable job row")
	}
}

func TestEngineeringGetRejectsIncompleteAndCASTamperedReceipt(t *testing.T) {
	fixture := newReceiptServiceSecurityFixture(t)
	ctx := context.Background()
	fresh, _, _ := executeReceiptServiceJob(t, fixture)

	pendingArguments := struct {
		RunID          string  `json:"run_id"`
		StageAttemptID string  `json:"stage_attempt_id"`
		MeshSizeM      float64 `json:"mesh_size_m"`
	}{RunID: fixture.run.ID, StageAttemptID: fixture.attempt.ID, MeshSizeM: 0.25}
	pendingHash := approveReceiptServiceJob(
		t, fixture, fixture.attempt, "gmsh_wing_mesh", pendingArguments,
	)
	pendingSpec := `{"arguments":{"mesh_size_m":0.25},"operation":"gmsh_wing_mesh","tool_version":"1"}`
	pendingDigest := sha256.Sum256([]byte(pendingSpec))
	pending, execute, err := fixture.database.BeginEngineeringJob(ctx, store.EngineeringJob{
		ProjectID: fixture.run.ProjectID, RunID: fixture.run.ID,
		StageAttemptID: fixture.attempt.ID, Operation: "gmsh_wing_mesh",
		SpecJSON: pendingSpec, SpecSHA256: hex.EncodeToString(pendingDigest[:]),
		ToolComponent: "gmsh", ToolVersion: "1", ApprovalScopeHash: pendingHash,
	})
	if err != nil || !execute {
		t.Fatalf("begin incomplete job: execute=%v err=%v", execute, err)
	}
	if _, err := fixture.service.EngineeringGet(ctx, fixture.run.ID, fixture.attempt.ID, pending.ID); err == nil {
		t.Fatal("engineering_get returned a running job without a completed receipt")
	}

	receiptHash := ""
	for _, artifact := range fresh.Artifacts {
		if artifact.Role == "receipt" {
			receiptHash = artifact.SHA256
			break
		}
	}
	if receiptHash == "" {
		t.Fatal("fresh result has no receipt artifact")
	}
	receiptPath, err := fixture.objects.Path(receiptHash)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(receiptPath, []byte("tampered receipt bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.EngineeringGet(ctx, fixture.run.ID, fixture.attempt.ID, fresh.JobID); err == nil {
		t.Fatal("engineering_get returned a receipt after CAS byte tampering")
	}
}
