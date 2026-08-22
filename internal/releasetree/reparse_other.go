//go:build !windows

package releasetree

import (
	"errors"
	"os"
)

func rejectReparse(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("release source tree contains a symbolic link")
	}
	return nil
}
