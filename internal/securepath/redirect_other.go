//go:build !windows

package securepath

import (
	"errors"
	"os"
	"path/filepath"
)

func rejectRedirectedComponents(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for current := absolute; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("path contains a symlink")
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
	}
}

func finalPath(file *os.File) (string, error) {
	return filepath.EvalSymlinks(file.Name())
}
