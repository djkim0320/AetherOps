//go:build windows && amd64

package desktop

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestProcessSupervisorTerminatesChildTreeOnClose(t *testing.T) {
	if runJobObjectHelper(t) {
		return
	}
	root := t.TempDir()
	signalPath := filepath.Join(root, "spawn.signal")
	pidPath := filepath.Join(root, "grandchild.pid")
	supervisor, err := NewProcessSupervisor()
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	t.Cleanup(func() {
		if !closed {
			_ = supervisor.Close()
		}
	})
	child, err := supervisor.Start(
		os.Args[0], "-test.run=^TestProcessSupervisorTerminatesChildTreeOnClose$", "--",
		"aetherops-job-child", signalPath, pidPath,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signalPath, []byte("spawn"), 0o600); err != nil {
		t.Fatal(err)
	}
	grandchildPID := waitForGrandchildPID(t, pidPath)
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()
	select {
	case <-childDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Job Object close did not terminate the supervised child")
	}
	if err := waitForProcessExit(grandchildPID, 5*time.Second); err != nil {
		t.Fatal(err)
	}
}

func TestProcessSupervisorRejectsStartAfterClose(t *testing.T) {
	supervisor, err := NewProcessSupervisor()
	if err != nil {
		t.Fatal(err)
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := supervisor.Start(os.Args[0], "-test.run=^$"); err == nil {
		t.Fatal("closed Job Object supervisor accepted a process")
	}
}

func runJobObjectHelper(t *testing.T) bool {
	childMarker := slices.Index(os.Args, "aetherops-job-child")
	if childMarker >= 0 {
		if len(os.Args) <= childMarker+2 {
			t.Fatal("job child helper paths are missing")
		}
		signalPath, pidPath := os.Args[childMarker+1], os.Args[childMarker+2]
		deadline := time.Now().Add(10 * time.Second)
		for {
			if _, err := os.Stat(signalPath); err == nil {
				break
			} else if !errors.Is(err, os.ErrNotExist) {
				t.Fatal(err)
			}
			if time.Now().After(deadline) {
				t.Fatal("job child helper timed out waiting for spawn signal")
			}
			time.Sleep(10 * time.Millisecond)
		}
		grandchild := exec.Command(os.Args[0], "-test.run=^TestProcessSupervisorTerminatesChildTreeOnClose$", "--", "aetherops-job-grandchild")
		if err := grandchild.Start(); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(pidPath, []byte(strconv.Itoa(grandchild.Process.Pid)), 0o600); err != nil {
			t.Fatal(err)
		}
		select {}
	}
	if slices.Contains(os.Args, "aetherops-job-grandchild") {
		select {}
	}
	return false
}

func waitForGrandchildPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		encoded, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(encoded)))
			if parseErr != nil || pid <= 0 {
				t.Fatalf("invalid grandchild pid %q: %v", encoded, parseErr)
			}
			return pid
		}
		if !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for grandchild pid")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForProcessExit(pid int, timeout time.Duration) error {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, uint32(timeout/time.Millisecond))
	if err != nil {
		return err
	}
	if status != windows.WAIT_OBJECT_0 {
		return errors.New("Job Object close did not terminate the supervised grandchild")
	}
	return nil
}
