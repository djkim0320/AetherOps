//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/releasegate"
)

func TestRunRequiresPreparedLedgerBeforeOpeningCandidate(t *testing.T) {
	err := run(context.Background(), []string{"-aetherops-exe", filepath.Join(t.TempDir(), "missing.exe")})
	if err == nil || !strings.Contains(err.Error(), "-prepared-ledger is required") {
		t.Fatalf("missing prepared ledger error = %v", err)
	}
}

func TestReleaseEvaluationArgumentsWrapOnlyNormalApp(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "data")
	arguments, descriptor, err := releaseEvaluationArguments([]string{"app"}, dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(arguments) != 5 || arguments[0] != "release-eval-session" ||
		arguments[1] != "--descriptor" || arguments[2] != descriptor ||
		arguments[3] != "--data-root" || arguments[4] != dataRoot {
		t.Fatalf("normal app launch was not wrapped in the exact readiness contract: args=%q descriptor=%q", arguments, descriptor)
	}
	if filepath.Dir(descriptor) != filepath.Dir(dataRoot) ||
		!strings.HasPrefix(filepath.Base(descriptor), "readiness-data-") ||
		!strings.HasSuffix(descriptor, ".json") {
		t.Fatalf("unexpected readiness descriptor path: %q", descriptor)
	}
	if _, err := os.Lstat(descriptor); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("readiness descriptor must be a new file: %v", err)
	}

	for _, test := range []struct {
		name string
		args []string
	}{
		{name: "empty", args: nil},
		{name: "other command", args: []string{"version"}},
		{name: "app with extra argument", args: []string{"app", "extra"}},
		{name: "different case", args: []string{"APP"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, descriptor, err := releaseEvaluationArguments(test.args, dataRoot)
			if err != nil {
				t.Fatal(err)
			}
			if descriptor != "" || !slices.Equal(got, test.args) {
				t.Fatalf("non-app launch was changed: got=%q descriptor=%q want=%q", got, descriptor, test.args)
			}
		})
	}
}

func TestReadNormalCoreReadinessStrictAcceptanceAndRejection(t *testing.T) {
	expectedBuild := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("a", 64),
		RuntimeManifestSHA256: strings.Repeat("b", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("c", 64),
	}
	valid := normalCoreReadiness{
		Schema: "aetherops_release_eval_api_session_v2", Endpoint: "http://127.0.0.1:43123",
		TokenFile: "readiness.json.token", PID: 1234, Mode: "normal", BuildMode: "release",
		ProductBuild: expectedBuild, StartedAt: time.Date(2026, 8, 10, 3, 4, 5, 6, time.UTC),
		RuntimeReady: true, CodexReady: true, OxigraphReady: true, APIReady: true,
	}
	validRaw, err := json.Marshal(valid)
	if err != nil {
		t.Fatal(err)
	}
	validPath := filepath.Join(t.TempDir(), "valid-readiness.json")
	if err := os.WriteFile(validPath, append(validRaw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readNormalCoreReadiness(validPath, expectedBuild)
	if err != nil {
		t.Fatalf("valid normal-core readiness was rejected: %v", err)
	}
	if got != valid {
		t.Fatalf("readiness changed during strict decoding: got=%+v want=%+v", got, valid)
	}
	if _, err := readNormalCoreReadiness(filepath.Join(t.TempDir(), "missing.json"), expectedBuild); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing readiness did not preserve os.ErrNotExist: %v", err)
	}

	mutations := []struct {
		name   string
		mutate func(*normalCoreReadiness)
	}{
		{name: "schema", mutate: func(value *normalCoreReadiness) { value.Schema = "v1" }},
		{name: "setup mode", mutate: func(value *normalCoreReadiness) { value.Mode = "setup" }},
		{name: "development build", mutate: func(value *normalCoreReadiness) { value.BuildMode = "development" }},
		{name: "missing pid", mutate: func(value *normalCoreReadiness) { value.PID = 0 }},
		{name: "missing start time", mutate: func(value *normalCoreReadiness) { value.StartedAt = time.Time{} }},
		{name: "missing endpoint", mutate: func(value *normalCoreReadiness) { value.Endpoint = "" }},
		{name: "missing token file", mutate: func(value *normalCoreReadiness) { value.TokenFile = "" }},
		{name: "different product build", mutate: func(value *normalCoreReadiness) { value.ProductBuild.ExecutableSHA256 = strings.Repeat("d", 64) }},
		{name: "runtime not ready", mutate: func(value *normalCoreReadiness) { value.RuntimeReady = false }},
		{name: "codex not ready", mutate: func(value *normalCoreReadiness) { value.CodexReady = false }},
		{name: "oxigraph not ready", mutate: func(value *normalCoreReadiness) { value.OxigraphReady = false }},
		{name: "api not ready", mutate: func(value *normalCoreReadiness) { value.APIReady = false }},
	}
	for _, test := range mutations {
		t.Run(test.name, func(t *testing.T) {
			value := valid
			test.mutate(&value)
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "readiness.json")
			if err := os.WriteFile(path, raw, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readNormalCoreReadiness(path, expectedBuild); err == nil {
				t.Fatal("invalid normal-core readiness was accepted")
			}
		})
	}

	strictJSONCases := []struct {
		name string
		raw  []byte
	}{
		{name: "unknown field", raw: append(append([]byte(nil), validRaw[:len(validRaw)-1]...), []byte(`,"unexpected":true}`)...)},
		{name: "trailing object", raw: append(append([]byte(nil), validRaw...), []byte("\n{}")...)},
		{name: "malformed", raw: []byte(`{"schema":`)},
	}
	for _, test := range strictJSONCases {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "readiness.json")
			if err := os.WriteFile(path, test.raw, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := readNormalCoreReadiness(path, expectedBuild); err == nil {
				t.Fatal("non-strict readiness JSON was accepted")
			}
		})
	}
}

func TestBindPreparedLedgerRequiresExactCandidateAndChangesWithLedger(t *testing.T) {
	root := t.TempDir()
	build := buildinfo.ProductBuildBinding{
		Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("a", 64),
		RuntimeManifestSHA256: strings.Repeat("b", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("c", 64),
	}
	firstPath := filepath.Join(root, "ledger-r1.json")
	writePreparedLedger(t, firstPath, build, time.Now().UTC().Add(-time.Minute))
	firstSHA256, err := bindPreparedLedger(firstPath, build, "packaged_blackbox")
	if err != nil {
		t.Fatal(err)
	}
	if len(firstSHA256) != sha256.Size*2 {
		t.Fatalf("prepared ledger SHA-256 = %q", firstSHA256)
	}

	mismatch := build
	mismatch.ExecutableSHA256 = strings.Repeat("d", 64)
	if _, err := bindPreparedLedger(firstPath, mismatch, "packaged_blackbox"); err == nil {
		t.Fatal("prepared ledger from another product build was accepted")
	}

	secondPath := filepath.Join(root, "same-candidate-different-ledger.json")
	writePreparedLedger(t, secondPath, build, time.Now().UTC().Add(-2*time.Minute))
	secondSHA256, err := bindPreparedLedger(secondPath, build, "packaged_blackbox")
	if err != nil {
		t.Fatal(err)
	}
	if secondSHA256 == firstSHA256 {
		t.Fatal("different prepared ledgers for the same candidate produced the same binding")
	}
}

func writePreparedLedger(t *testing.T, path string, build buildinfo.ProductBuildBinding, preparedAt time.Time) {
	t.Helper()
	ledger, err := releasegate.PrepareLedger(build, preparedAt)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCandidateIdentityRejectsSidecarTamperBeforeLaunch(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "aetherops.exe")
	manifest := filepath.Join(root, "runtime-manifest.json")
	sidecar := filepath.Join(root, "knowledge-sidecar")
	for path, data := range map[string][]byte{
		executable:                             []byte("candidate executable"),
		manifest:                               []byte("candidate runtime manifest"),
		filepath.Join(sidecar, "index.cjs"):    []byte("index"),
		filepath.Join(sidecar, "protocol.cjs"): []byte("protocol"),
		filepath.Join(sidecar, "worker.cjs"):   []byte("worker"),
	} {
		if err := writeDurableFileNew(path, data); err != nil {
			t.Fatal(err)
		}
	}
	expected, err := buildinfo.BindProductBuild(executable, manifest, filepath.Join(sidecar, "index.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	if err := detachAndAppend(filepath.Join(sidecar, "protocol.cjs"), []byte("tampered")); err != nil {
		t.Fatal(err)
	}
	actual, err := buildinfo.BindProductBuild(executable, manifest, filepath.Join(sidecar, "index.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	if err := requireCandidateIdentity(expected, actual); err == nil {
		t.Fatal("tampered sidecar retained the sealed candidate identity")
	}
}

func TestHardlinkMirrorDetachesTamperedFile(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	destination := filepath.Join(root, "destination")
	original := filepath.Join(source, "component", "payload.bin")
	if err := writeDurableFileNew(original, []byte("original")); err != nil {
		t.Fatal(err)
	}
	if err := mirrorTreeWithHardlinks(source, destination); err != nil {
		t.Fatal(err)
	}
	tampered := filepath.Join(destination, "component", "payload.bin")
	if err := detachAndAppend(tampered, []byte("-tampered")); err != nil {
		t.Fatal(err)
	}
	sourceData, err := os.ReadFile(original)
	if err != nil {
		t.Fatal(err)
	}
	if string(sourceData) != "original" {
		t.Fatalf("source candidate changed through hardlink: %q", sourceData)
	}
	tamperedData, err := os.ReadFile(tampered)
	if err != nil {
		t.Fatal(err)
	}
	if string(tamperedData) != "original-tampered" {
		t.Fatalf("unexpected tampered copy: %q", tamperedData)
	}
}

func TestWriteJSONNewRefusesOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "receipt.json")
	if err := writeJSONNew(path, map[string]int{"schema": 1}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONNew(path, map[string]int{"schema": 2}); err == nil {
		t.Fatal("receipt overwrite was accepted")
	}
}

func TestTemporaryCleanupAcceptsOnlyExactHarnessChild(t *testing.T) {
	parent := t.TempDir()
	root, err := os.MkdirTemp(parent, ".packaged-blackbox-run-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeDurableFileNew(filepath.Join(root, "data", "marker"), []byte("fixture")); err != nil {
		t.Fatal(err)
	}
	if err := removeBlackboxTemporary(root, parent); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("temporary root survived cleanup: %v", err)
	}
	unsafe := filepath.Join(parent, "unreviewed")
	if err := os.Mkdir(unsafe, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := removeBlackboxTemporary(unsafe, parent); err == nil {
		t.Fatal("unreviewed directory name was accepted for recursive cleanup")
	}
	if _, err := os.Stat(unsafe); err != nil {
		t.Fatalf("rejected cleanup changed its target: %v", err)
	}
}

func TestIsolatedDataRootRejectsProductionTree(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	production := filepath.Join(local, "AetherOps", "v2")
	if err := ensureIsolatedDataRoot(production); err == nil {
		t.Fatal("production data root was accepted")
	}
	if err := ensureIsolatedDataRoot(filepath.Join(production, "blackbox-child")); err == nil {
		t.Fatal("production data descendant was accepted")
	}
	isolated := filepath.Join(t.TempDir(), "isolated-data")
	if err := ensureIsolatedDataRoot(isolated); err != nil {
		t.Fatalf("independent isolated root rejected: %v", err)
	}
}

func TestRuntimeSealComparisonBindsAllTrees(t *testing.T) {
	left := runtimeSeal{ActiveSHA256: "a", SetSHA256: "b", TreeSHA256: map[string]string{"node": "c"}}
	right := runtimeSeal{ActiveSHA256: "a", SetSHA256: "b", TreeSHA256: map[string]string{"node": "c"}}
	if !sameRuntimeSeal(left, right) {
		t.Fatal("equal runtime seals did not compare equal")
	}
	right.TreeSHA256["node"] = "d"
	if sameRuntimeSeal(left, right) {
		t.Fatal("runtime tree mutation retained seal equality")
	}
}

func TestCandidateIDBindsEveryProductBuildField(t *testing.T) {
	base := buildinfo.ProductBuildBinding{
		Version:                    buildinfo.ReleaseProductVersion,
		ExecutableSHA256:           "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RuntimeManifestSHA256:      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		KnowledgeSidecarTreeSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
	}
	want, err := releasegate.CandidateID(base)
	if err != nil {
		t.Fatal(err)
	}
	mutations := []buildinfo.ProductBuildBinding{base, base, base, base}
	mutations[0].Version += "-changed"
	mutations[1].ExecutableSHA256 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
	mutations[2].RuntimeManifestSHA256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	mutations[3].KnowledgeSidecarTreeSHA256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	for _, mutation := range mutations {
		got, err := releasegate.CandidateID(mutation)
		if err != nil && mutation.Version == buildinfo.ReleaseProductVersion {
			t.Fatal(err)
		}
		if got == want {
			t.Fatalf("candidate ID did not bind mutation: %+v", mutation)
		}
	}
}
