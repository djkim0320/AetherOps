//go:build windows

package processutil

import (
	"os/exec"
	"testing"
)

func TestConfigureNoWindowPreservesPipesWithoutConsole(t *testing.T) {
	command := exec.Command("cmd.exe", "/c", "exit", "0")
	ConfigureNoWindow(command)
	if command.SysProcAttr == nil || !command.SysProcAttr.HideWindow || command.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("no-window process policy was not applied: %#v", command.SysProcAttr)
	}
}
