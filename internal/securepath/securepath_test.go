package securepath

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadRegularWithinRejectsTraversalAndSymlinks(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "evidence.json")
	if err := os.WriteFile(inside, []byte(`{"schema":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	raw, err := ReadRegularWithin(root, "evidence.json", 1024)
	if err != nil || string(raw) != `{"schema":1}` {
		t.Fatalf("regular read=%q err=%v", raw, err)
	}
	if _, err := ReadRegularWithin(root, `..\outside.json`, 1024); err == nil {
		t.Fatal("traversal was accepted")
	}
	link := filepath.Join(root, "link.json")
	if err := os.Symlink(inside, link); err == nil {
		if _, err := ReadRegularWithin(root, "link.json", 1024); err == nil {
			t.Fatal("terminal symlink was accepted")
		}
	}
}

func TestSiblingNameRejectsDirectoriesAndAlternateStreams(t *testing.T) {
	for _, value := range []string{"", "../receipt.json", `nested\receipt.json`, "receipt.json:stream"} {
		if _, err := SiblingName(value); err == nil {
			t.Fatalf("unsafe sibling name %q was accepted", value)
		}
	}
	if got, err := SiblingName("receipt.details.json"); err != nil || got != "receipt.details.json" {
		t.Fatalf("safe sibling=%q err=%v", got, err)
	}
}
