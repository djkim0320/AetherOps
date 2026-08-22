package releasegate

import (
	"errors"
	"fmt"
)

const packagedBlackboxFixtureExitCode = 93

type packagedForcedTerminationDetails struct {
	ActualExecutableForciblyTerminated  *bool  `json:"actual_executable_forcibly_terminated"`
	FixtureProcessExitCode              *int   `json:"fixture_process_exit_code"`
	WALBytesBeforePackagedRecovery      *int64 `json:"wal_bytes_before_packaged_recovery"`
	WALBytesAfterIdempotenceLaunch      *int64 `json:"wal_bytes_after_idempotence_launch"`
	WALCheckpointExecutor               string `json:"wal_checkpoint_executor"`
	WALCheckpointBusy                   *int   `json:"wal_checkpoint_busy"`
	WALCheckpointLogFrames              *int   `json:"wal_checkpoint_log_frames"`
	WALCheckpointedFrames               *int   `json:"wal_checkpointed_frames"`
	WALBytesAfterTruncateCheckpoint     *int64 `json:"wal_bytes_after_truncate_checkpoint"`
	DatabaseIntegrity                   string `json:"database_integrity"`
	ReadOnlyRunStatus                   string `json:"read_only_run_status"`
	SideEffectRunStatus                 string `json:"side_effect_run_status"`
	ExternalThreadTurnIdentityPreserved *bool  `json:"external_thread_turn_identity_preserved"`
	DuplicateStageAttempts              *int   `json:"duplicate_stage_attempts"`
	DuplicateRecoveryEvents             *int   `json:"duplicate_recovery_events"`
	IncompleteCurationGenerationRemoved *bool  `json:"incomplete_curation_generation_removed"`
	OrphanedAndTemporaryCASRemoved      *bool  `json:"orphaned_and_temporary_cas_removed"`
	ReachableCASReadbackVerified        *bool  `json:"reachable_cas_readback_verified"`
	SecondStartStateUnchanged           *bool  `json:"second_start_state_unchanged"`
	SecondStartCrossedResetCheckpoint   *bool  `json:"second_start_crossed_reset_checkpoint"`
}

type packagedTamperDetails struct {
	RuntimeActualExecutableExitCode           *int  `json:"runtime_actual_executable_exit_code"`
	RuntimeLaunchBlocked                      *bool `json:"runtime_launch_blocked"`
	RuntimeFailureContainsContentHashMismatch *bool `json:"runtime_failure_contains_content_hash_mismatch"`
	SidecarLaunchAttempted                    *bool `json:"sidecar_launch_attempted"`
	SidecarPrelaunchCandidateIdentityRejected *bool `json:"sidecar_prelaunch_candidate_identity_rejected"`
	SourceCandidateUnchanged                  *bool `json:"source_candidate_unchanged"`
}

type packagedCandidateStabilityDetails struct {
	CandidateReauthenticatedAfterCampaign *bool `json:"candidate_reauthenticated_after_campaign"`
}

type packagedCleanupDetails struct {
	TemporaryRootRemoved *bool `json:"temporary_root_removed"`
}

func validatePackagedBlackboxScenario(scenario PackagedBlackboxScenario, subjects map[string]string) error {
	switch scenario.ID {
	case "forced_termination_recovery":
		var details packagedForcedTerminationDetails
		if err := decodeStrict(scenario.Details, &details); err != nil {
			return fmt.Errorf("decode forced-termination details: %w", err)
		}
		if !requiredBool(details.ActualExecutableForciblyTerminated, true) ||
			details.FixtureProcessExitCode == nil || *details.FixtureProcessExitCode != packagedBlackboxFixtureExitCode ||
			details.WALBytesBeforePackagedRecovery == nil || *details.WALBytesBeforePackagedRecovery <= 0 ||
			details.WALBytesAfterIdempotenceLaunch == nil || *details.WALBytesAfterIdempotenceLaunch < 0 ||
			details.WALCheckpointExecutor != "release_harness_after_packaged_process_exit" ||
			details.WALCheckpointBusy == nil || *details.WALCheckpointBusy != 0 ||
			details.WALCheckpointLogFrames == nil || *details.WALCheckpointLogFrames < 0 ||
			details.WALCheckpointedFrames == nil || *details.WALCheckpointedFrames != *details.WALCheckpointLogFrames ||
			details.WALBytesAfterTruncateCheckpoint == nil || *details.WALBytesAfterTruncateCheckpoint != 0 ||
			details.DatabaseIntegrity != "ok" || details.ReadOnlyRunStatus != "interrupted" ||
			details.SideEffectRunStatus != "uncertain" ||
			!requiredBool(details.ExternalThreadTurnIdentityPreserved, true) ||
			details.DuplicateStageAttempts == nil || *details.DuplicateStageAttempts != 0 ||
			details.DuplicateRecoveryEvents == nil || *details.DuplicateRecoveryEvents != 0 ||
			!requiredBool(details.IncompleteCurationGenerationRemoved, true) ||
			!requiredBool(details.OrphanedAndTemporaryCASRemoved, true) ||
			!requiredBool(details.ReachableCASReadbackVerified, true) ||
			!requiredBool(details.SecondStartStateUnchanged, true) ||
			!requiredBool(details.SecondStartCrossedResetCheckpoint, true) {
			return errors.New("forced-termination details do not prove the fixed recovery, zero-duplicate, WAL, and CAS contract")
		}
		if !validDigest(subjects["recovered_database_sha256"]) {
			return errors.New("forced-termination details lack the recovered database SHA-256 subject")
		}
		return nil

	case "runtime_and_sidecar_tamper":
		var details packagedTamperDetails
		if err := decodeStrict(scenario.Details, &details); err != nil {
			return fmt.Errorf("decode runtime/sidecar tamper details: %w", err)
		}
		if details.RuntimeActualExecutableExitCode == nil || *details.RuntimeActualExecutableExitCode == 0 ||
			!requiredBool(details.RuntimeLaunchBlocked, true) ||
			!requiredBool(details.RuntimeFailureContainsContentHashMismatch, true) ||
			!requiredBool(details.SidecarLaunchAttempted, false) ||
			!requiredBool(details.SidecarPrelaunchCandidateIdentityRejected, true) ||
			!requiredBool(details.SourceCandidateUnchanged, true) {
			return errors.New("runtime/sidecar tamper details do not prove fail-closed prelaunch rejection")
		}
		for _, pair := range [][2]string{
			{"tamper_runtime_original_sha256", "tamper_runtime_mutated_sha256"},
			{"tamper_sidecar_original_sha256", "tamper_sidecar_mutated_sha256"},
		} {
			original, mutated := subjects[pair[0]], subjects[pair[1]]
			if !validDigest(original) || !validDigest(mutated) || original == mutated {
				return fmt.Errorf("tamper subjects %q and %q do not bind distinct original/mutated SHA-256 values", pair[0], pair[1])
			}
		}
		return nil

	case "candidate_stability":
		var details packagedCandidateStabilityDetails
		if err := decodeStrict(scenario.Details, &details); err != nil {
			return fmt.Errorf("decode candidate-stability details: %w", err)
		}
		if !requiredBool(details.CandidateReauthenticatedAfterCampaign, true) {
			return errors.New("candidate-stability details do not prove post-campaign reauthentication")
		}
		return nil

	case "isolated_fixture_cleanup":
		var details packagedCleanupDetails
		if err := decodeStrict(scenario.Details, &details); err != nil {
			return fmt.Errorf("decode fixture-cleanup details: %w", err)
		}
		if !requiredBool(details.TemporaryRootRemoved, true) {
			return errors.New("fixture-cleanup details do not prove exact temporary-root removal")
		}
		return nil
	default:
		return fmt.Errorf("packaged black-box scenario %q is unknown", scenario.ID)
	}
}

func requiredBool(value *bool, want bool) bool {
	return value != nil && *value == want
}
