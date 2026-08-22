//go:build !windows

package processutil

import "os/exec"

func ConfigureNoWindow(_ *exec.Cmd) {}
