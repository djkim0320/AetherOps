//go:build !windows

package evalrunner

import (
	"errors"
	"os"
)

func lockJournalFile(*os.File) error {
	return errors.New("release evaluation runner is supported only on Windows")
}

func unlockJournalFile(*os.File) error { return nil }
