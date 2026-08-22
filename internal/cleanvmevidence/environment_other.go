//go:build !windows

package cleanvmevidence

import (
	"errors"
	"time"
)

func CaptureEnvironment(time.Time) (VMEnvironment, error) {
	return VMEnvironment{}, errors.New("clean VM evidence is supported only on Windows")
}

func CaptureHostIdentity(time.Time) (string, string, error) {
	return "", "", errors.New("clean VM host references are supported only on Windows")
}
