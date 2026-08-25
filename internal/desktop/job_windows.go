//go:build windows && amd64

package desktop

import (
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"github.com/djkim0320/AetherOps/internal/processutil"
	"golang.org/x/sys/windows"
)

// ProcessSupervisor owns a Windows Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Every successful Start call assigns the
// new process to that Job before returning it to the caller.
type ProcessSupervisor struct {
	mu     sync.Mutex
	job    windows.Handle
	closed bool
}

// SupervisedProcess is the process returned by ProcessSupervisor.Start.
// The Job Object, rather than CommandContext, is the authoritative tree-kill
// mechanism because it includes descendants created by the helper.
type SupervisedProcess struct {
	cmd *exec.Cmd
}

func newProcessSupervisor() (*ProcessSupervisor, error) {
	return NewProcessSupervisor()
}

func NewProcessSupervisor() (*ProcessSupervisor, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	return &ProcessSupervisor{job: job}, nil
}

// Assign places an already-started process and its future descendants under
// this Job Object. Failure is returned so the caller can kill the process
// before it performs work outside supervision.
func (supervisor *ProcessSupervisor) Assign(processID int) error {
	if processID <= 0 {
		return errors.New("process id is required")
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.closed || supervisor.job == 0 {
		return errors.New("Windows Job Object supervisor is closed")
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(processID))
	if err != nil {
		return fmt.Errorf("open helper process for Job Object assignment: %w", err)
	}
	assignErr := windows.AssignProcessToJobObject(supervisor.job, process)
	closeErr := windows.CloseHandle(process)
	if assignErr != nil {
		return fmt.Errorf("assign helper process to Job Object: %w", assignErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close helper process assignment handle: %w", closeErr)
	}
	return nil
}

// Start is fail-closed: if opening or assigning the process fails, the just
// started process is killed and waited before Start returns an error.
func (supervisor *ProcessSupervisor) Start(name string, args ...string) (*SupervisedProcess, error) {
	if name == "" {
		return nil, errors.New("supervised process name is required")
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.closed || supervisor.job == 0 {
		return nil, errors.New("Windows Job Object supervisor is closed")
	}

	command := exec.Command(name, args...)
	processutil.ConfigureNoWindow(command)
	if err := command.Start(); err != nil {
		return nil, err
	}

	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(command.Process.Pid))
	if err != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		return nil, fmt.Errorf("open helper process for Job Object assignment: %w", err)
	}
	assignErr := windows.AssignProcessToJobObject(supervisor.job, process)
	closeErr := windows.CloseHandle(process)
	if assignErr != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		return nil, fmt.Errorf("assign helper process to Job Object: %w", assignErr)
	}
	if closeErr != nil {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
		return nil, fmt.Errorf("close helper process assignment handle: %w", closeErr)
	}
	return &SupervisedProcess{cmd: command}, nil
}

func (process *SupervisedProcess) PID() int {
	if process == nil || process.cmd == nil || process.cmd.Process == nil {
		return 0
	}
	return process.cmd.Process.Pid
}

func (process *SupervisedProcess) Wait() error {
	if process == nil || process.cmd == nil {
		return errors.New("supervised process is nil")
	}
	return process.cmd.Wait()
}

// Close closes the Job Object. Windows terminates every remaining member and
// its child processes because the kill-on-close limit was set at creation.
func (supervisor *ProcessSupervisor) Close() error {
	if supervisor == nil {
		return nil
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.closed {
		return nil
	}
	supervisor.closed = true
	if supervisor.job == 0 {
		return nil
	}
	err := windows.CloseHandle(supervisor.job)
	supervisor.job = 0
	return err
}
