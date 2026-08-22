//go:build !windows

package evalrunner

import "errors"

func validateDescriptorProcess(int, string) error {
	return errors.New("release evaluation sessions are supported only on Windows")
}
