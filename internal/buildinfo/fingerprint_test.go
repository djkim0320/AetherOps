package buildinfo

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKnowledgeSidecarTreeCanonicalCrossLanguageVector(t *testing.T) {
	directory := t.TempDir()
	fixtures := map[string]string{
		"index.cjs":    "index fixture\n",
		"protocol.cjs": "protocol fixture\n",
		"worker.cjs":   "worker fixture\n",
	}
	for _, name := range knowledgeSidecarFiles {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(fixtures[name]), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	digest, err := hashKnowledgeSidecarTree(filepath.Join(directory, "index.cjs"))
	if err != nil {
		t.Fatal(err)
	}
	const expected = "955dd24b963f8db133fe9deb778d8cb5b6f3618ae808c433323e1cb0565ba962"
	if digest != expected {
		t.Fatalf("knowledge sidecar tree digest = %s, want %s", digest, expected)
	}
}
