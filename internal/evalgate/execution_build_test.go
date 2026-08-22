package evalgate

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExecutionManifestBindsExactProductFiles(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "aetherops.exe")
	runtimeManifest := filepath.Join(root, "runtime-manifest.json")
	sidecarDirectory := filepath.Join(root, "knowledge-sidecar")
	if err := os.Mkdir(sidecarDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	sidecar := filepath.Join(sidecarDirectory, "index.cjs")
	if err := os.WriteFile(executable, []byte("exact executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runtimeManifest, []byte("exact runtime"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.cjs", "protocol.cjs", "worker.cjs"} {
		if err := os.WriteFile(filepath.Join(sidecarDirectory, name), []byte("exact "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	binding, err := BindProductBuild(executable, runtimeManifest, sidecar)
	if err != nil {
		t.Fatal(err)
	}
	if binding.ExecutableSHA256 == binding.RuntimeManifestSHA256 {
		t.Fatal("different product inputs produced the same binding")
	}
	if err := os.WriteFile(executable, []byte("rebuilt executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := BindProductBuild(executable, runtimeManifest, sidecar)
	if err != nil {
		t.Fatal(err)
	}
	if rebuilt == binding {
		t.Fatal("rebuilt executable retained the prepared product binding")
	}
	for _, sibling := range []string{"protocol.cjs", "worker.cjs"} {
		if err := os.WriteFile(executable, []byte("exact executable"), 0o600); err != nil {
			t.Fatal(err)
		}
		before, err := BindProductBuild(executable, runtimeManifest, sidecar)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(sidecarDirectory, sibling)
		original, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(original, []byte(" changed")...), 0o600); err != nil {
			t.Fatal(err)
		}
		after, err := BindProductBuild(executable, runtimeManifest, sidecar)
		if err != nil {
			t.Fatal(err)
		}
		if after == before {
			t.Fatalf("changing %s retained the sidecar tree binding", sibling)
		}
		if err := os.WriteFile(path, original, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestExecutionManifestRejectsInvalidProductBinding(t *testing.T) {
	dataset, err := LoadDataset(filepath.Join("..", "..", "evals", "research-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := PrepareExecutionManifest(dataset, time.Now(), testProductBuildBinding())
	if err != nil {
		t.Fatal(err)
	}
	manifest.ProductBuild.ExecutableSHA256 = "not-a-digest"
	if err := manifest.Validate(dataset, false); err == nil {
		t.Fatal("execution manifest accepted an invalid executable binding")
	}
}
