//go:build windows

package evalrunner

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

func lockJournalFile(file *os.File) error {
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, overlapped,
	); err != nil {
		return fmt.Errorf("acquire exclusive evaluation journal lock: %w", err)
	}
	return nil
}

func unlockJournalFile(file *os.File) error {
	overlapped := new(windows.Overlapped)
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, overlapped)
}
