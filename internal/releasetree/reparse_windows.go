//go:build windows

package releasetree

import (
	"errors"

	"golang.org/x/sys/windows"
)

func rejectReparse(path string) error {
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("release source tree contains a Windows reparse point")
	}
	return nil
}
