package core

import "fmt"

var allowedTransitions = map[RunStatus]map[RunStatus]bool{
	RunQueued: {
		RunPlanning: true, RunFailed: true, RunCancelled: true,
	},
	RunPlanning: {
		RunCollecting: true, RunWaitingApproval: true, RunFailed: true,
		RunCancelled: true, RunInterrupted: true, RunUncertain: true,
	},
	RunCollecting: {
		RunSynthesizing: true, RunWaitingApproval: true, RunFailed: true,
		RunCancelled: true, RunInterrupted: true, RunUncertain: true,
	},
	RunSynthesizing: {
		RunReviewing: true, RunWaitingApproval: true, RunFailed: true,
		RunCancelled: true, RunInterrupted: true, RunUncertain: true,
	},
	RunReviewing: {
		RunSucceeded: true, RunRevising: true, RunPlanning: true, RunQualityFailed: true,
		RunFailed: true, RunCancelled: true, RunInterrupted: true, RunUncertain: true,
	},
	RunRevising: {
		RunReviewing: true, RunWaitingApproval: true, RunFailed: true,
		RunCancelled: true, RunInterrupted: true, RunUncertain: true,
	},
	RunWaitingApproval: {
		RunPlanning: true, RunCollecting: true, RunSynthesizing: true,
		RunReviewing: true, RunRevising: true, RunFailed: true, RunCancelled: true,
		RunInterrupted: true, RunUncertain: true,
	},
	RunInterrupted: {
		RunPlanning: true, RunCollecting: true, RunSynthesizing: true,
		RunReviewing: true, RunRevising: true, RunCancelled: true,
	},
	RunUncertain: {
		RunCancelled: true, RunFailed: true,
	},
}

func CanTransition(from, to RunStatus) bool {
	return allowedTransitions[from][to]
}

func RequireTransition(from, to RunStatus) error {
	if !CanTransition(from, to) {
		return fmt.Errorf("invalid run transition %s -> %s", from, to)
	}
	return nil
}

func IsTerminal(status RunStatus) bool {
	switch status {
	case RunSucceeded, RunQualityFailed, RunFailed, RunCancelled:
		return true
	default:
		return false
	}
}

func RecoveryStatus(_ Stage, externalSideEffects bool) RunStatus {
	if externalSideEffects {
		return RunUncertain
	}
	return RunInterrupted
}
