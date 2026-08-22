//go:build windows

package evalrunner

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

func validateDescriptorProcess(pid int, expectedExecutableSHA256 string) error {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return errors.New("release evaluation descriptor process is not running")
	}
	defer windows.CloseHandle(handle)
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil || size == 0 {
		return errors.New("release evaluation descriptor process image is unavailable")
	}
	path := windows.UTF16ToString(buffer[:size])
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("release evaluation descriptor process image is invalid")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("release evaluation descriptor process image cannot be read")
	}
	hash := sha256.New()
	written, copyErr := io.Copy(hash, file)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || written != info.Size() {
		return errors.New("release evaluation descriptor process image changed while hashing")
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expectedExecutableSHA256) {
		return errors.New("release evaluation descriptor process image differs from the selected packaged executable")
	}
	return nil
}
