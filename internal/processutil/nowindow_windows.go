//go:build windows

// Package processutil applies the small set of platform process policies used
// by AetherOps-owned child launches.
package processutil

import (
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

// ConfigureNoWindow prevents console-subsystem helpers from creating a CMD
// window. Standard input/output pipes continue to work normally.
func ConfigureNoWindow(command *exec.Cmd) {
	if command == nil {
		return
	}
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.HideWindow = true
	command.SysProcAttr.CreationFlags |= createNoWindow
}
