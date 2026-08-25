//go:build windows && amd64

package su2hostevidence

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/djkim0320/AetherOps/internal/su2host"
)

func TestCompatibleHostLeavesExternalGatePendingWithoutOutputs(t *testing.T) {
	observation, err := su2host.ObserveNative()
	if err != nil {
		t.Fatal(err)
	}
	if !observation.Compatible() {
		t.Skip("real host is incompatible; this no-output contract is exercised only on compatible hardware")
	}
	root := t.TempDir()
	output := filepath.Join(root, "incompatible.receipt.json")
	_, err = Generate(context.Background(), Config{
		LedgerPath: filepath.Join(root, "missing-ledger.json"), OutputPath: output,
		AetherOpsExecutablePath: filepath.Join(root, "missing.exe"), RuntimeManifestPath: filepath.Join(root, "missing-manifest.json"),
		KnowledgeSidecarEntrypoint: filepath.Join(root, "missing-sidecar", "index.cjs"),
	})
	if !errors.Is(err, ErrHostCompatible) {
		t.Fatalf("compatible host did not return the pending sentinel: %v", err)
	}
	for _, path := range []string{output, filepath.Join(root, "incompatible.receipt.details.json")} {
		if _, statErr := os.Lstat(path); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("compatible host created evidence output %s: %v", path, statErr)
		}
	}
}

func TestProducerConfigHasNoFeatureOrResultInjectionSurface(t *testing.T) {
	typeOf := reflect.TypeOf(Config{})
	want := []string{"LedgerPath", "OutputPath", "AetherOpsExecutablePath", "RuntimeManifestPath", "KnowledgeSidecarEntrypoint"}
	if typeOf.NumField() != len(want) {
		t.Fatalf("producer config gained an injection surface: %+v", typeOf)
	}
	for index, name := range want {
		if typeOf.Field(index).Name != name || typeOf.Field(index).Type.Kind() != reflect.String {
			t.Fatalf("unexpected producer config field %d: %+v", index, typeOf.Field(index))
		}
	}
}
