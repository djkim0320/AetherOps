//go:build windows && amd64

package main

import (
	"os"

	"github.com/djkim0320/AetherOps/internal/core"
)

func osWriteTestFile(path string) error {
	return os.WriteFile(path, []byte("not a data root"), 0o600)
}

func coreRunForRejectedProof() core.Run {
	return core.Run{ID: "run", ProjectID: "project"}
}
