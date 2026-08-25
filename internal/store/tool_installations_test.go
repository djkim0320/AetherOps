package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func toolTestHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func createPortableToolTestPackage(t *testing.T, database *DB, projectID, name string) core.ToolPackage {
	t.Helper()
	content := `{"schema":"aetherops_tool_package_v2"}`
	pkg, err := database.CreateToolPackage(context.Background(), core.ToolPackage{
		ProjectID: projectID, Kind: "mcp", Name: name, DisplayName: "Portable test tool",
		Description: "Exercises durable portable tool storage", Version: "1.0.0",
		ManifestJSON: content, PackageSHA256: toolTestHash("package-" + name),
		Files: []core.ToolPackageFile{{
			Path: "mcp.json", Content: content, ContentSHA256: toolTestHash(content), Size: int64(len(content)),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return pkg
}

func TestPortableToolInstallationGrantAndInvocationAreExactAndIdempotent(t *testing.T) {
	database, objects := openTestDB(t)
	ctx := context.Background()
	project, err := database.CreateProject(ctx, "portable tool lifecycle")
	if err != nil {
		t.Fatal(err)
	}
	pkg := createPortableToolTestPackage(t, database, project.ID, "portable-test")
	payload, err := objects.PutBytes([]byte("portable executable payload"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, payload, "application/vnd.microsoft.portable-executable"); err != nil {
		t.Fatal(err)
	}
	approvalHash := toolTestHash("exact user approval")
	installation, start, err := database.BeginToolInstallation(ctx, core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: project.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approvalHash, ExpectedPayloadSHA256: payload.Hash,
	})
	if err != nil || !start {
		t.Fatalf("begin installation: start=%v err=%v", start, err)
	}
	duplicate, start, err := database.BeginToolInstallation(ctx, core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: project.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approvalHash, ExpectedPayloadSHA256: payload.Hash,
	})
	if err != nil || start || duplicate.ID != installation.ID {
		t.Fatalf("duplicate installation was not idempotent: %+v start=%v err=%v", duplicate, start, err)
	}
	size := payload.Size
	installation, err = database.UpdateToolInstallation(ctx, installation.ID, "downloading", ToolInstallationUpdate{
		State: "verifying", PayloadBlobHash: payload.Hash, PayloadSizeBytes: &size,
	})
	if err != nil {
		t.Fatal(err)
	}
	installation, err = database.UpdateToolInstallation(ctx, installation.ID, "verifying", ToolInstallationUpdate{State: "installing"})
	if err != nil {
		t.Fatal(err)
	}
	installation, err = database.UpdateToolInstallation(ctx, installation.ID, "installing", ToolInstallationUpdate{State: "probing"})
	if err != nil {
		t.Fatal(err)
	}
	probe, err := objects.PutBytes([]byte("portable-test 1.0.0"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, probe, "text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	installation, err = database.CompleteToolInstallation(ctx, installation.ID, toolTestHash("installed tree"), "portable-test.exe", probe.Hash)
	if err != nil {
		t.Fatal(err)
	}
	listed, err := database.ToolPackage(ctx, project.ID, pkg.ID, false)
	if err != nil || listed.Installation == nil || listed.Installation.ID != installation.ID || listed.Installation.State != "ready" {
		t.Fatalf("package did not attach ready installation: %+v err=%v", listed.Installation, err)
	}
	pkg, err = database.ActivateToolPackage(ctx, project.ID, pkg.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err := database.CreateRun(ctx, project.ID, "", "use portable tool", "thread")
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
	grant, err := database.CreateToolStageGrant(ctx, core.ToolStageGrant{
		ProjectID: project.ID, RunID: run.ID, StageAttemptID: attempt.ID,
		PackageID: pkg.ID, InstallationID: installation.ID,
		PackageSHA256: pkg.PackageSHA256, ApprovalSHA256: approvalHash,
	})
	if err != nil {
		t.Fatal(err)
	}
	exact, err := database.ToolStageGrant(ctx, project.ID, run.ID, attempt.ID, pkg.ID,
		installation.ID, pkg.PackageSHA256, approvalHash)
	if err != nil || exact.ID != grant.ID {
		t.Fatalf("exact stage grant lookup: %+v err=%v", exact, err)
	}
	if ok, err := database.HasExactToolStageGrant(ctx, project.ID, run.ID, attempt.ID, pkg.ID,
		installation.ID, pkg.PackageSHA256, toolTestHash("different approval")); err != nil || ok {
		t.Fatalf("different approval widened exact stage grant: ok=%v err=%v", ok, err)
	}
	invocationInput := core.ToolInvocation{
		IdempotencyKey: "codex-call-1", ProjectID: project.ID, RunID: run.ID,
		StageAttemptID: attempt.ID, PackageID: pkg.ID, InstallationID: installation.ID,
		StageGrantID: grant.ID, ToolName: "portable-test",
		ArgumentsSHA256: toolTestHash(`{"value":1}`), AdapterSHA256: toolTestHash("adapter-v1"),
	}
	invocation, execute, err := database.ReserveToolInvocation(ctx, invocationInput)
	if err != nil || !execute {
		t.Fatalf("reserve invocation: execute=%v err=%v", execute, err)
	}
	duplicateInvocation, execute, err := database.ReserveToolInvocation(ctx, invocationInput)
	if err != nil || execute || duplicateInvocation.ID != invocation.ID {
		t.Fatalf("duplicate invocation was not at-most-once: %+v execute=%v err=%v", duplicateInvocation, execute, err)
	}
	differentCallID := invocationInput
	differentCallID.IdempotencyKey = "different-call-id-same-operation"
	operationDuplicate, execute, err := database.ReserveToolInvocation(ctx, differentCallID)
	if err != nil || execute || operationDuplicate.ID != invocation.ID {
		t.Fatalf("new call id bypassed exact-operation dedupe: %+v execute=%v err=%v", operationDuplicate, execute, err)
	}
	tampered := invocationInput
	tampered.ArgumentsSHA256 = toolTestHash(`{"value":2}`)
	if _, execute, err := database.ReserveToolInvocation(ctx, tampered); err == nil || execute {
		t.Fatal("idempotency key accepted different arguments")
	}
	stdout, err := objects.PutBytes([]byte(`{"result":2}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, stdout, "application/json"); err != nil {
		t.Fatal(err)
	}
	completed, err := database.CompleteToolInvocation(ctx, invocation.ID, stdout.Hash, "", 0)
	if err != nil || completed.State != "succeeded" {
		t.Fatalf("complete invocation: %+v err=%v", completed, err)
	}
	repeated, err := database.CompleteToolInvocation(ctx, invocation.ID, stdout.Hash, "", 0)
	if err != nil || repeated.ID != invocation.ID {
		t.Fatalf("repeated completion was not idempotent: %+v err=%v", repeated, err)
	}
	failedInput := invocationInput
	failedInput.IdempotencyKey = "codex-call-failed"
	failedInput.ArgumentsSHA256 = toolTestHash(`{"value":"fail"}`)
	failedInvocation, execute, err := database.ReserveToolInvocation(ctx, failedInput)
	if err != nil || !execute {
		t.Fatalf("reserve failing invocation: execute=%v err=%v", execute, err)
	}
	failure := errors.New("portable process exited before output validation")
	failedInvocation, err = database.FailToolInvocation(ctx, failedInvocation.ID, failure)
	if err != nil || failedInvocation.State != "failed" {
		t.Fatalf("fail invocation: %+v err=%v", failedInvocation, err)
	}
	repeatedFailure, err := database.FailToolInvocation(ctx, failedInvocation.ID, failure)
	if err != nil || repeatedFailure.ID != failedInvocation.ID {
		t.Fatalf("repeated failure was not idempotent: %+v err=%v", repeatedFailure, err)
	}
	uncertainInput := invocationInput
	uncertainInput.IdempotencyKey = "codex-call-2"
	uncertainInput.ArgumentsSHA256 = toolTestHash(`{"value":3}`)
	uncertainInvocation, execute, err := database.ReserveToolInvocation(ctx, uncertainInput)
	if err != nil || !execute {
		t.Fatalf("reserve recovery invocation: execute=%v err=%v", execute, err)
	}
	if _, err := database.RecoverInFlight(ctx); err != nil {
		t.Fatal(err)
	}
	uncertainInvocation, err = database.ToolInvocation(ctx, uncertainInvocation.ID)
	if err != nil || uncertainInvocation.State != "uncertain" || uncertainInvocation.CompletedAt == nil {
		t.Fatalf("running invocation recovery: %+v err=%v", uncertainInvocation, err)
	}
	if _, err := database.RecoverInFlight(ctx); err != nil {
		t.Fatalf("repeated recovery: %v", err)
	}
	var uncertainEvents int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM run_events
WHERE run_id=? AND kind='tool.invocation.uncertain'`, run.ID).Scan(&uncertainEvents); err != nil || uncertainEvents != 1 {
		t.Fatalf("uncertain invocation event count=%d err=%v", uncertainEvents, err)
	}
}

func TestRecoverInFlightInterruptsInstallAndMakesInvocationUncertain(t *testing.T) {
	database, objects := openTestDB(t)
	ctx := context.Background()
	project, err := database.CreateProject(ctx, "portable recovery")
	if err != nil {
		t.Fatal(err)
	}
	pkg := createPortableToolTestPackage(t, database, project.ID, "recovery-tool")
	payload, err := objects.PutBytes([]byte("recovery payload"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, payload, "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	approvalHash := toolTestHash("recovery approval")
	installation, _, err := database.BeginToolInstallation(ctx, core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: project.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approvalHash, ExpectedPayloadSHA256: payload.Hash,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.RecoverInFlight(ctx); err != nil {
		t.Fatal(err)
	}
	recovered, err := database.ToolInstallation(ctx, installation.ID)
	if err != nil || recovered.State != "interrupted" || recovered.CompletedAt == nil {
		t.Fatalf("installation recovery: %+v err=%v", recovered, err)
	}
	retry, _, err := database.BeginToolInstallation(ctx, core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: project.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: approvalHash, ExpectedPayloadSHA256: payload.Hash,
	})
	if err != nil {
		t.Fatalf("new installation attempt after interruption: %v", err)
	}
	failure := errors.New("download verification failed")
	retry, err = database.FailToolInstallation(ctx, retry.ID, failure)
	if err != nil || retry.State != "failed" {
		t.Fatalf("fail retry installation: %+v err=%v", retry, err)
	}
	if repeated, err := database.FailToolInstallation(ctx, retry.ID, failure); err != nil || repeated.ID != retry.ID {
		t.Fatalf("repeated installation failure was not idempotent: %+v err=%v", repeated, err)
	}
	var eventCount int
	if err := database.SQL().QueryRowContext(ctx, `SELECT COUNT(*) FROM tool_install_events
WHERE installation_id=? AND action='interrupted'`, installation.ID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("interrupted install event count=%d err=%v", eventCount, err)
	}
}

func TestProjectDeletionIncludesPortableInstallationCASReferences(t *testing.T) {
	database, objects := openTestDB(t)
	ctx := context.Background()
	project, err := database.CreateProject(ctx, "portable CAS deletion")
	if err != nil {
		t.Fatal(err)
	}
	pkg := createPortableToolTestPackage(t, database, project.ID, "deletion-tool")
	payload, err := objects.PutBytes([]byte("delete portable payload"))
	if err != nil {
		t.Fatal(err)
	}
	probe, err := objects.PutBytes([]byte("delete probe output"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, payload, "application/octet-stream"); err != nil {
		t.Fatal(err)
	}
	if err := database.RegisterBlob(ctx, probe, "text/plain"); err != nil {
		t.Fatal(err)
	}
	installation, _, err := database.BeginToolInstallation(ctx, core.ToolInstallation{
		PackageID: pkg.ID, ProjectID: project.ID, PackageSHA256: pkg.PackageSHA256,
		ApprovalSHA256: toolTestHash("delete approval"), ExpectedPayloadSHA256: payload.Hash,
	})
	if err != nil {
		t.Fatal(err)
	}
	size := payload.Size
	for _, update := range []struct {
		expected string
		value    ToolInstallationUpdate
	}{
		{"downloading", ToolInstallationUpdate{State: "verifying", PayloadBlobHash: payload.Hash, PayloadSizeBytes: &size}},
		{"verifying", ToolInstallationUpdate{State: "installing"}},
		{"installing", ToolInstallationUpdate{State: "probing"}},
	} {
		if _, err := database.UpdateToolInstallation(ctx, installation.ID, update.expected, update.value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.CompleteToolInstallation(ctx, installation.ID, toolTestHash("delete tree"), "delete.exe", probe.Hash); err != nil {
		t.Fatal(err)
	}
	orphaned, err := database.DeleteProject(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{payload.Hash: false, probe.Hash: false}
	for _, hash := range orphaned {
		if _, ok := want[hash]; ok {
			want[hash] = true
		}
	}
	for hash, found := range want {
		if !found {
			t.Fatalf("portable CAS hash %s was omitted from deletion cleanup: %v", hash, orphaned)
		}
		if _, err := database.BlobMetadata(ctx, hash); !errors.Is(err, ErrNotFound) {
			t.Fatalf("portable CAS blob row survived project deletion: %s err=%v", hash, err)
		}
	}
}
