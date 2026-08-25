// Package releasegate verifies that every release requirement is backed by
// evidence of the exact required class for one immutable product candidate.
// It is release tooling only and is never imported by the desktop core.
package releasegate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/releasetree"
	"github.com/djkim0320/AetherOps/internal/securepath"
)

const (
	LedgerSchemaV1                  = "aetherops_release_gate_ledger_v1"
	EvidenceSchemaV1                = "aetherops_release_gate_evidence_v1"
	AdmissionSchemaV1               = "aetherops_release_admission_v1"
	PackagedBlackboxDetailsSchemaV1 = "aetherops_packaged_blackbox_details_v1"

	candidateDomain                   = "aetherops-release-candidate-v1\x00"
	packagedBlackboxEnvironmentDomain = "aetherops-packaged-blackbox-environment-v1\x00"
	maxAuditJSON                      = 4 << 20
)

type EvidenceKind string

const (
	EvidenceLocalIntegration     EvidenceKind = "local_integration"
	EvidencePackagedBlackbox     EvidenceKind = "packaged_blackbox"
	EvidenceLiveService          EvidenceKind = "live_service"
	EvidenceLiveEvaluation       EvidenceKind = "live_eval"
	EvidenceCleanVM              EvidenceKind = "clean_vm"
	EvidenceIncompatibleHardware EvidenceKind = "incompatible_hardware"
	EvidenceProductionFeed       EvidenceKind = "production_feed"
)

var gateIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

type GateRequirement struct {
	GateID               string       `json:"gate_id"`
	RequiredEvidenceKind EvidenceKind `json:"required_evidence_kind"`
	External             bool         `json:"external"`
}

// RequiredGates is the non-overridable v1 admission policy. A caller cannot
// remove or downgrade gates with a policy file, flag, or environment variable.
func RequiredGates() []GateRequirement {
	return []GateRequirement{
		{GateID: "local_source_tests", RequiredEvidenceKind: EvidenceLocalIntegration},
		{GateID: "gate0_windows_host", RequiredEvidenceKind: EvidenceLocalIntegration},
		{GateID: "rag_50000", RequiredEvidenceKind: EvidenceLocalIntegration},
		{GateID: "scheduler_recovery", RequiredEvidenceKind: EvidenceLocalIntegration},
		{GateID: "packaged_blackbox", RequiredEvidenceKind: EvidencePackagedBlackbox},
		{GateID: "live_auth_exact_models", RequiredEvidenceKind: EvidenceLiveService, External: true},
		{GateID: "live_embeddings_shadow", RequiredEvidenceKind: EvidenceLiveService, External: true},
		{GateID: "live_end_to_end", RequiredEvidenceKind: EvidenceLiveService, External: true},
		{GateID: "live_quality_12", RequiredEvidenceKind: EvidenceLiveEvaluation, External: true},
		{GateID: "clean_vm_installer", RequiredEvidenceKind: EvidenceCleanVM, External: true},
		{GateID: "clean_vm_portable", RequiredEvidenceKind: EvidenceCleanVM, External: true},
		{GateID: "production_update_feed", RequiredEvidenceKind: EvidenceProductionFeed, External: true},
		{GateID: "incompatible_su2_host", RequiredEvidenceKind: EvidenceIncompatibleHardware, External: true},
	}
}

type gateEvidencePolicy struct {
	ProducerName     string
	ProducerVersion  string
	DetailsSubject   string
	RequiredSubjects []string
}

func evidencePolicy(gateID string) (gateEvidencePolicy, bool) {
	base := []string{"aetherops.exe", "runtime-manifest.json", "knowledge-sidecar-tree"}
	with := func(subjects ...string) []string {
		return append(append([]string(nil), base...), subjects...)
	}
	switch gateID {
	case "local_source_tests":
		return gateEvidencePolicy{"cmd/localreleaseevidence", "2", "local-source-test-receipt", with(
			"prepared-ledger", "local-gate-details", "local-source-test-receipt", "source-tree",
			"go1.26.5.exe", "windows-powershell.exe", "tools-dev.ps1", "node-24.19.0.exe", "npm-11.17.0.cmd", "npm-11.17.0-cli.js",
			"command_go_version_stdout", "command_go_version_stderr", "command_node_version_stdout", "command_node_version_stderr",
			"command_npm_version_stdout", "command_npm_version_stderr", "command_local_source_tests_stdout", "command_local_source_tests_stderr",
		)}, true
	case "gate0_windows_host":
		return gateEvidencePolicy{"cmd/localreleaseevidence", "2", "gate0-windows-host-receipt", with(
			"prepared-ledger", "local-gate-details", "gate0-windows-host-receipt", "gate_artifact",
			"command_packaged_gate0_stdout", "command_packaged_gate0_stderr",
		)}, true
	case "rag_50000":
		return gateEvidencePolicy{"cmd/localreleaseevidence", "2", "rag-50000-receipt", with(
			"prepared-ledger", "local-gate-details", "rag-50000-receipt", "source-tree", "go1.26.5.exe", "gate_artifact",
			"command_go_version_stdout", "command_go_version_stderr", "command_rag_50000_stdout", "command_rag_50000_stderr",
		)}, true
	case "scheduler_recovery":
		return gateEvidencePolicy{"cmd/localreleaseevidence", "2", "scheduler-recovery-receipt", with(
			"prepared-ledger", "local-gate-details", "scheduler-recovery-receipt", "source-tree", "go1.26.5.exe",
			"command_go_version_stdout", "command_go_version_stderr", "command_scheduler_contracts_stdout", "command_scheduler_contracts_stderr",
			"command_scheduler_forced_exit_stdout", "command_scheduler_forced_exit_stderr",
		)}, true
	case "packaged_blackbox":
		return gateEvidencePolicy{"cmd/packagedblackbox", "1", "packaged-blackbox-details", with(
			"prepared-ledger", "packaged-blackbox-details", "recovered_database_sha256",
			"runtime_active_pointer_sha256", "verified_runtime_set_sha256",
			"runtime_tree_chrome_devtools_mcp_sha256", "runtime_tree_codex_sha256",
			"runtime_tree_gmsh_sha256", "runtime_tree_node_sha256",
			"runtime_tree_openvsp_sha256", "runtime_tree_oxigraph_sha256",
			"runtime_tree_su2_sha256", "runtime_tree_xfoil_sha256",
			"tamper_runtime_original_sha256", "tamper_runtime_mutated_sha256",
			"tamper_sidecar_original_sha256", "tamper_sidecar_mutated_sha256",
		)}, true
	case "live_auth_exact_models":
		return gateEvidencePolicy{"cmd/liveauthevidence", "1", "live-auth-exact-models-details", with(
			"prepared-ledger", "live-auth-exact-models-details", "release-session-descriptor",
			"auth-codex-status-response", "product-status-response",
		)}, true
	case "live_embeddings_shadow":
		return gateEvidencePolicy{"cmd/liveembeddingsevidence:offline-finalize", "1", "live-embeddings-shadow-details", with(
			"prepared-ledger", "release-eval-runner-receipt", "live-embedding-journal",
			"active-memory-index", "previous-memory-index", "memory-query", "search-readback",
			"cas-source-set", "vector-set", "durable-memory-proof", "live-embeddings-shadow-details",
		)}, true
	case "live_quality_12":
		return gateEvidencePolicy{"cmd/releaseeval:verify-runner", "1", "release-evaluation-details", with(
			"prepared-ledger", "evaluation-dataset", "release-eval-runner-receipt", "release-evaluation-details",
		)}, true
	case "live_end_to_end":
		return gateEvidencePolicy{"cmd/livee2eevidence:offline-finalize", "2", "live-end-to-end-details", with(
			"prepared-ledger", "release-eval-runner-receipt", "release-evaluation-details",
			"release-eval-runner-endpoint", "live-e2e-observation-endpoint",
			"live-e2e-observation-session-descriptor", "live-e2e-journal", "live-e2e-run",
			"stage-receipt-set", "mcp-evidence-set", "browser-devtools-observation",
			"engineering-solver-receipt", "cas-readback-set", "sparql-readback",
			"knowledge-curation-event", "live-end-to-end-details",
		)}, true
	case "clean_vm_installer", "clean_vm_portable":
		return gateEvidencePolicy{"cmd/cleanvmevidence", "1", "clean-vm-details", with(
			cleanVMRequiredSubjects()...,
		)}, true
	case "production_update_feed":
		return gateEvidencePolicy{"cmd/productionfeedevidence", "1", "production-feed-details", with(
			"prepared-ledger", "production-feed-details", "runtime-manifest-input",
			"embedded-trust-diagnostic", "embedded-trust-public-key", "production-feed-url",
			"production-feed-envelope", "production-feed-payload",
			"production-feed-leaf-certificate", "runtime-active-pointer", "browser-endpoint",
			"runtime_payload_node", "runtime_tree_node", "artifact_attestation_node",
			"runtime_payload_codex", "runtime_tree_codex", "artifact_attestation_codex",
			"runtime_payload_chrome_devtools_mcp", "runtime_tree_chrome_devtools_mcp", "artifact_attestation_chrome_devtools_mcp",
			"runtime_payload_oxigraph", "runtime_tree_oxigraph", "artifact_attestation_oxigraph",
			"runtime_payload_openvsp", "runtime_tree_openvsp", "artifact_attestation_openvsp",
			"runtime_payload_gmsh", "runtime_tree_gmsh", "artifact_attestation_gmsh",
			"runtime_payload_xfoil", "runtime_tree_xfoil", "artifact_attestation_xfoil",
			"runtime_payload_su2", "runtime_tree_su2", "artifact_attestation_su2",
		)}, true
	case "incompatible_su2_host":
		return gateEvidencePolicy{"cmd/su2hostevidence", "1", "incompatible-su2-host-details", with(
			"prepared-ledger", "incompatible-su2-host-details", "native-cpuid-observation",
			"candidate-su2-preflight-stdout", "candidate-su2-preflight-stderr",
		)}, true
	default:
		// Every other external gate deliberately has no trusted producer yet.
		// A self-declared receipt must not turn missing real infrastructure into
		// release evidence.
		return gateEvidencePolicy{}, false
	}
}

type EvidenceReference struct {
	GateID        string `json:"gate_id"`
	ReceiptPath   string `json:"receipt_path"`
	ReceiptSHA256 string `json:"receipt_sha256"`
}

type Ledger struct {
	Schema               string                        `json:"schema"`
	ReleaseCandidateID   string                        `json:"release_candidate_id"`
	ProductBuild         buildinfo.ProductBuildBinding `json:"product_build"`
	Revision             int                           `json:"revision"`
	PreviousLedgerPath   string                        `json:"previous_ledger_path,omitempty"`
	PreviousLedgerSHA256 string                        `json:"previous_ledger_sha256,omitempty"`
	PreparedAt           time.Time                     `json:"prepared_at"`
	Evidence             []EvidenceReference           `json:"evidence"`
}

type Producer struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type Environment struct {
	Class          string `json:"class"`
	OS             string `json:"os"`
	Architecture   string `json:"architecture"`
	IdentitySHA256 string `json:"identity_sha256"`
}

type SubjectHash struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

type EvidenceReceipt struct {
	Schema             string                        `json:"schema"`
	GateID             string                        `json:"gate_id"`
	EvidenceKind       EvidenceKind                  `json:"evidence_kind"`
	ReleaseCandidateID string                        `json:"release_candidate_id"`
	ProductBuild       buildinfo.ProductBuildBinding `json:"product_build"`
	Producer           Producer                      `json:"producer"`
	Environment        Environment                   `json:"environment"`
	ObservedAt         time.Time                     `json:"observed_at"`
	Status             string                        `json:"status"`
	SubjectHashes      []SubjectHash                 `json:"subject_hashes"`
	DetailsPath        string                        `json:"details_path"`
	DetailsSHA256      string                        `json:"details_sha256"`
}

type PackagedBlackboxEnvironment struct {
	OS                  string `json:"os"`
	Architecture        string `json:"architecture"`
	GoVersion           string `json:"go_version"`
	LogicalProcessors   int    `json:"logical_processors"`
	ProcessorIdentifier string `json:"processor_identifier,omitempty"`
	WindowsVersion      string `json:"windows_version"`
}

type PackagedBlackboxScenario struct {
	ID      string          `json:"id"`
	Status  string          `json:"status"`
	Details json.RawMessage `json:"details"`
}

type PackagedBlackboxLimits struct {
	PackagedBlackboxGateEligible bool     `json:"packaged_blackbox_gate_eligible"`
	ExternalGateEligible         bool     `json:"external_gate_eligible"`
	Proves                       []string `json:"proves"`
	DoesNotProve                 []string `json:"does_not_prove"`
}

type PackagedBlackboxDetails struct {
	Schema                string                      `json:"schema"`
	ReleaseCandidateID    string                      `json:"release_candidate_id"`
	CandidateExecutable   string                      `json:"candidate_executable"`
	Environment           PackagedBlackboxEnvironment `json:"environment"`
	IsolatedDataOnly      bool                        `json:"isolated_data_only"`
	TemporaryRootRetained bool                        `json:"temporary_root_retained"`
	TemporaryRoot         string                      `json:"temporary_root,omitempty"`
	FixtureRole           string                      `json:"fixture_role"`
	Scenarios             []PackagedBlackboxScenario  `json:"scenarios"`
	EvidenceLimits        PackagedBlackboxLimits      `json:"evidence_limits"`
}

type GateResult struct {
	GateID               string       `json:"gate_id"`
	RequiredEvidenceKind EvidenceKind `json:"required_evidence_kind"`
	ActualEvidenceKind   EvidenceKind `json:"actual_evidence_kind,omitempty"`
	Status               string       `json:"status"`
	ReceiptSHA256        string       `json:"receipt_sha256,omitempty"`
	Failure              string       `json:"failure,omitempty"`
}

type AdmissionReceipt struct {
	Schema             string                        `json:"schema"`
	ReleaseCandidateID string                        `json:"release_candidate_id"`
	ProductBuild       buildinfo.ProductBuildBinding `json:"product_build"`
	VerifiedAt         time.Time                     `json:"verified_at"`
	RequiredGates      int                           `json:"required_gates"`
	PassedGates        int                           `json:"passed_gates"`
	Passed             bool                          `json:"passed"`
	LedgerSHA256       string                        `json:"ledger_sha256"`
	Results            []GateResult                  `json:"results"`
}

func CandidateID(build buildinfo.ProductBuildBinding) (string, error) {
	if err := build.Validate(); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(struct {
		Version                    string `json:"version"`
		ExecutableSHA256           string `json:"executable_sha256"`
		RuntimeManifestSHA256      string `json:"runtime_manifest_sha256"`
		KnowledgeSidecarTreeSHA256 string `json:"knowledge_sidecar_tree_sha256"`
	}{build.Version, build.ExecutableSHA256, build.RuntimeManifestSHA256, build.KnowledgeSidecarTreeSHA256})
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	_, _ = io.WriteString(digest, candidateDomain)
	_, _ = digest.Write(canonical)
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func PrepareLedger(build buildinfo.ProductBuildBinding, now time.Time) (Ledger, error) {
	candidateID, err := CandidateID(build)
	if err != nil {
		return Ledger{}, err
	}
	if now.IsZero() {
		now = time.Now()
	}
	requirements := RequiredGates()
	ledger := Ledger{
		Schema: LedgerSchemaV1, ReleaseCandidateID: candidateID, ProductBuild: build,
		Revision: 1, PreparedAt: now.UTC(), Evidence: make([]EvidenceReference, len(requirements)),
	}
	for index, requirement := range requirements {
		ledger.Evidence[index] = EvidenceReference{GateID: requirement.GateID}
	}
	return ledger, nil
}

func LoadLedger(path string) (Ledger, string, error) {
	raw, err := readRegular(path)
	if err != nil {
		return Ledger{}, "", err
	}
	var ledger Ledger
	if err := decodeStrict(raw, &ledger); err != nil {
		return Ledger{}, "", fmt.Errorf("decode release gate ledger: %w", err)
	}
	digest := sha256.Sum256(raw)
	if err := ledger.Validate(); err != nil {
		return Ledger{}, "", err
	}
	return ledger, hex.EncodeToString(digest[:]), nil
}

func LoadLedgerChain(path string) (Ledger, string, error) {
	state, err := loadLedgerChainState(path)
	if err != nil {
		return Ledger{}, "", err
	}
	return state.Tip, state.TipHash, nil
}

type ledgerChainState struct {
	Tip                            Ledger
	TipHash                        string
	PreparedLedgerByGateID         map[string]string
	PreparedLedgerRevisionByGateID map[string]int
}

func loadLedgerChainState(path string) (ledgerChainState, error) {
	ledgerPath, err := securepath.RegularPath(path)
	if err != nil {
		return ledgerChainState{}, err
	}
	tip, tipHash, err := LoadLedger(ledgerPath)
	if err != nil {
		return ledgerChainState{}, err
	}
	if tip.Revision > len(RequiredGates())+1 {
		return ledgerChainState{}, errors.New("release ledger revision exceeds the fixed gate count")
	}
	current := tip
	currentPath := ledgerPath
	seenPaths := map[string]struct{}{strings.ToLower(filepath.Base(ledgerPath)): {}}
	preparedLedgerByGateID := make(map[string]string, current.Revision-1)
	preparedLedgerRevisionByGateID := make(map[string]int, current.Revision-1)
	for current.Revision > 1 {
		name, err := securepath.SiblingName(current.PreviousLedgerPath)
		if err != nil {
			return ledgerChainState{}, err
		}
		key := strings.ToLower(name)
		if _, duplicate := seenPaths[key]; duplicate {
			return ledgerChainState{}, errors.New("release ledger predecessor chain contains a cycle")
		}
		seenPaths[key] = struct{}{}
		previousPath := filepath.Join(filepath.Dir(currentPath), name)
		previous, previousHash, err := LoadLedger(previousPath)
		if err != nil {
			return ledgerChainState{}, fmt.Errorf("load release ledger predecessor: %w", err)
		}
		if previousHash != current.PreviousLedgerSHA256 || previous.Revision+1 != current.Revision ||
			previous.ProductBuild != current.ProductBuild || previous.ReleaseCandidateID != current.ReleaseCandidateID ||
			!previous.PreparedAt.Equal(current.PreparedAt) {
			return ledgerChainState{}, errors.New("release ledger predecessor identity or SHA-256 is invalid")
		}
		gateID, err := attachedGateID(previous, current)
		if err != nil {
			return ledgerChainState{}, err
		}
		if _, duplicate := preparedLedgerByGateID[gateID]; duplicate {
			return ledgerChainState{}, fmt.Errorf("release ledger chain attaches gate %q more than once", gateID)
		}
		preparedLedgerByGateID[gateID] = previousHash
		preparedLedgerRevisionByGateID[gateID] = previous.Revision
		current, currentPath = previous, previousPath
	}
	return ledgerChainState{
		Tip: tip, TipHash: tipHash, PreparedLedgerByGateID: preparedLedgerByGateID,
		PreparedLedgerRevisionByGateID: preparedLedgerRevisionByGateID,
	}, nil
}

func requireOneAttachment(previous, current Ledger) error {
	_, err := attachedGateID(previous, current)
	return err
}

func attachedGateID(previous, current Ledger) (string, error) {
	prior := make(map[string]EvidenceReference, len(previous.Evidence))
	for _, reference := range previous.Evidence {
		prior[reference.GateID] = reference
	}
	attachments := 0
	attachedGate := ""
	for _, reference := range current.Evidence {
		old, ok := prior[reference.GateID]
		if !ok {
			return "", errors.New("release ledger revision changed the fixed gate set")
		}
		switch {
		case old == reference:
		case old.ReceiptPath == "" && old.ReceiptSHA256 == "" && reference.ReceiptPath != "" && reference.ReceiptSHA256 != "":
			attachments++
			attachedGate = reference.GateID
		default:
			return "", fmt.Errorf("release ledger revision replaced evidence for gate %q", reference.GateID)
		}
	}
	if attachments != 1 {
		return "", fmt.Errorf("release ledger revision attached %d evidence rows, want exactly 1", attachments)
	}
	return attachedGate, nil
}

func AttachEvidence(currentLedgerPath, receiptPath, outputLedgerPath string, expectedBuild buildinfo.ProductBuildBinding, now time.Time) (Ledger, error) {
	currentPath, err := securepath.RegularPath(currentLedgerPath)
	if err != nil {
		return Ledger{}, err
	}
	chain, err := loadLedgerChainState(currentPath)
	if err != nil {
		return Ledger{}, err
	}
	current, currentHash := chain.Tip, chain.TipHash
	if current.ProductBuild != expectedBuild {
		return Ledger{}, errors.New("release ledger is bound to a different product build")
	}
	outputAbsolute, err := filepath.Abs(outputLedgerPath)
	if err != nil {
		return Ledger{}, err
	}
	if _, err := securepath.SiblingName(filepath.Base(outputAbsolute)); err != nil ||
		!strings.EqualFold(filepath.Dir(outputAbsolute), filepath.Dir(currentPath)) ||
		strings.EqualFold(filepath.Base(outputAbsolute), filepath.Base(currentPath)) {
		return Ledger{}, errors.New("attached ledger must be a new direct sibling of its predecessor")
	}
	receiptAbsolute, err := securepath.RegularPath(receiptPath)
	if err != nil {
		return Ledger{}, err
	}
	if !strings.EqualFold(filepath.Dir(receiptAbsolute), filepath.Dir(currentPath)) {
		return Ledger{}, errors.New("release evidence receipt must be a direct ledger sibling")
	}
	raw, err := readRegular(receiptAbsolute)
	if err != nil {
		return Ledger{}, err
	}
	var evidence EvidenceReceipt
	if err := decodeStrict(raw, &evidence); err != nil {
		return Ledger{}, err
	}
	if err := evidence.Validate(); err != nil {
		return Ledger{}, err
	}
	if evidence.ProductBuild != current.ProductBuild || evidence.ReleaseCandidateID != current.ReleaseCandidateID {
		return Ledger{}, errors.New("release evidence belongs to a different candidate")
	}
	subjects, subjectErr := receiptSubjectMap(evidence)
	if subjectErr != nil {
		return Ledger{}, subjectErr
	}
	if subjects["prepared-ledger"] != currentHash {
		return Ledger{}, errors.New("release evidence was not produced from the exact current ledger revision")
	}
	if evidence.Status != "passed" {
		return Ledger{}, errors.New("failed release evidence cannot be attached")
	}
	if now.IsZero() {
		now = time.Now()
	}
	if evidence.ObservedAt.Before(current.PreparedAt) || evidence.ObservedAt.After(now.Add(10*time.Minute)) {
		return Ledger{}, errors.New("release evidence timestamp is outside the candidate ledger window")
	}
	if err := verifyEvidenceDetailsForLedger(receiptAbsolute, evidence, current.Revision, current.PreparedAt); err != nil {
		return Ledger{}, err
	}
	attached := false
	next := current
	next.Evidence = append([]EvidenceReference(nil), current.Evidence...)
	digest := sha256.Sum256(raw)
	for index, reference := range next.Evidence {
		if reference.GateID != evidence.GateID {
			continue
		}
		if reference.ReceiptPath != "" || reference.ReceiptSHA256 != "" {
			return Ledger{}, fmt.Errorf("release gate %q already has immutable evidence", evidence.GateID)
		}
		next.Evidence[index].ReceiptPath = filepath.Base(receiptAbsolute)
		next.Evidence[index].ReceiptSHA256 = hex.EncodeToString(digest[:])
		attached = true
		break
	}
	if !attached {
		return Ledger{}, errors.New("release evidence gate is not in the fixed policy")
	}
	next.Revision = current.Revision + 1
	next.PreviousLedgerPath = filepath.Base(currentPath)
	next.PreviousLedgerSHA256 = currentHash
	if err := next.Validate(); err != nil {
		return Ledger{}, err
	}
	if err := requireOneAttachment(current, next); err != nil {
		return Ledger{}, err
	}
	return next, nil
}

func (ledger Ledger) Validate() error {
	if ledger.Schema != LedgerSchemaV1 || ledger.PreparedAt.IsZero() || ledger.Revision < 1 {
		return errors.New("release gate ledger schema, revision, and prepared_at are required")
	}
	if ledger.Revision == 1 {
		if ledger.PreviousLedgerPath != "" || ledger.PreviousLedgerSHA256 != "" {
			return errors.New("initial release ledger cannot name a predecessor")
		}
	} else if _, err := securepath.SiblingName(ledger.PreviousLedgerPath); err != nil || !validDigest(ledger.PreviousLedgerSHA256) {
		return errors.New("release ledger predecessor path or SHA-256 is invalid")
	}
	candidateID, err := CandidateID(ledger.ProductBuild)
	if err != nil {
		return fmt.Errorf("release gate product build: %w", err)
	}
	if ledger.ReleaseCandidateID != candidateID {
		return errors.New("release gate ledger candidate id does not match product build")
	}
	required := make(map[string]struct{}, len(RequiredGates()))
	for _, gate := range RequiredGates() {
		required[gate.GateID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(ledger.Evidence))
	for _, reference := range ledger.Evidence {
		if _, ok := required[reference.GateID]; !ok {
			return fmt.Errorf("release gate ledger contains unknown gate %q", reference.GateID)
		}
		if _, duplicate := seen[reference.GateID]; duplicate {
			return fmt.Errorf("release gate ledger contains duplicate gate %q", reference.GateID)
		}
		seen[reference.GateID] = struct{}{}
		pathPresent := strings.TrimSpace(reference.ReceiptPath) != ""
		hashPresent := strings.TrimSpace(reference.ReceiptSHA256) != ""
		if pathPresent != hashPresent {
			return fmt.Errorf("release gate %q must provide receipt path and SHA-256 together", reference.GateID)
		}
		if hashPresent && !validDigest(reference.ReceiptSHA256) {
			return fmt.Errorf("release gate %q has an invalid receipt SHA-256", reference.GateID)
		}
		if pathPresent {
			if _, err := securepath.SiblingName(reference.ReceiptPath); err != nil {
				return fmt.Errorf("release gate %q receipt must be a direct sibling: %w", reference.GateID, err)
			}
		}
	}
	if len(seen) != len(required) {
		return fmt.Errorf("release gate ledger has %d gate rows, want %d", len(seen), len(required))
	}
	if ledger.Revision == 1 {
		for _, reference := range ledger.Evidence {
			if reference.ReceiptPath != "" || reference.ReceiptSHA256 != "" {
				return errors.New("initial release ledger must be empty; evidence requires an attach revision")
			}
		}
	}
	return nil
}

func (receipt EvidenceReceipt) Validate() error {
	if receipt.Schema != EvidenceSchemaV1 || !gateIDPattern.MatchString(receipt.GateID) {
		return errors.New("release evidence schema or gate id is invalid")
	}
	requirement, ok := requirementForGate(receipt.GateID)
	if !ok || receipt.EvidenceKind != requirement.RequiredEvidenceKind {
		return errors.New("release evidence gate or evidence kind is not in the fixed policy")
	}
	policy, trusted := evidencePolicy(receipt.GateID)
	if !trusted {
		return fmt.Errorf("release gate %q has no trusted evidence producer", receipt.GateID)
	}
	candidateID, err := CandidateID(receipt.ProductBuild)
	if err != nil {
		return fmt.Errorf("release evidence product build: %w", err)
	}
	if receipt.ReleaseCandidateID != candidateID {
		return errors.New("release evidence candidate id does not match product build")
	}
	if receipt.Producer.Name != policy.ProducerName || receipt.Producer.Version != policy.ProducerVersion {
		return errors.New("release evidence producer is not trusted for this gate")
	}
	if strings.TrimSpace(receipt.Environment.Class) == "" || strings.TrimSpace(receipt.Environment.OS) == "" ||
		strings.TrimSpace(receipt.Environment.Architecture) == "" || !validDigest(receipt.Environment.IdentitySHA256) {
		return errors.New("release evidence environment identity is incomplete")
	}
	if receipt.Environment.Class != string(receipt.EvidenceKind) {
		return errors.New("release evidence environment class does not match evidence kind")
	}
	if receipt.ObservedAt.IsZero() || (receipt.Status != "passed" && receipt.Status != "failed") {
		return errors.New("release evidence observed_at and passed/failed status are required")
	}
	if _, err := securepath.SiblingName(receipt.DetailsPath); err != nil ||
		!strings.HasSuffix(receipt.DetailsPath, ".details.json") || !validDigest(receipt.DetailsSHA256) {
		return errors.New("release evidence details sibling path or SHA-256 is invalid")
	}
	requiredSubjects := map[string]string{
		"aetherops.exe":          receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":  receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree": receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
	}
	for _, name := range policy.RequiredSubjects {
		if _, exists := requiredSubjects[name]; !exists {
			requiredSubjects[name] = ""
		}
	}
	seen := make(map[string]struct{}, len(receipt.SubjectHashes))
	for _, subject := range receipt.SubjectHashes {
		if strings.TrimSpace(subject.Name) == "" || !validDigest(subject.SHA256) {
			return errors.New("release evidence contains an invalid subject hash")
		}
		if _, duplicate := seen[subject.Name]; duplicate {
			return fmt.Errorf("release evidence subject %q is duplicated", subject.Name)
		}
		seen[subject.Name] = struct{}{}
		if want, required := requiredSubjects[subject.Name]; required && want != "" && subject.SHA256 != want {
			return fmt.Errorf("release evidence subject %q does not match product build", subject.Name)
		}
		if subject.Name == policy.DetailsSubject && subject.SHA256 != receipt.DetailsSHA256 {
			return fmt.Errorf("release evidence details subject %q does not match details SHA-256", subject.Name)
		}
	}
	for name := range requiredSubjects {
		if _, ok := seen[name]; !ok {
			// A failed Gate 0/RAG observation can terminate before the candidate
			// emits its artifact. Preserve a structurally valid failure receipt so
			// diagnostics are durable; AttachEvidence rejects every failed receipt
			// before any details can enter the immutable release ledger.
			if receipt.Status == "failed" && name == "gate_artifact" {
				continue
			}
			return fmt.Errorf("release evidence is missing required subject %q", name)
		}
	}
	return nil
}

func requirementForGate(gateID string) (GateRequirement, bool) {
	for _, requirement := range RequiredGates() {
		if requirement.GateID == gateID {
			return requirement, true
		}
	}
	return GateRequirement{}, false
}

func isLocalReleaseGate(gateID string) bool {
	return gateID == "local_source_tests" || gateID == "gate0_windows_host" ||
		gateID == "rag_50000" || gateID == "scheduler_recovery"
}

func verifyEvidenceDetails(receiptPath string, receipt EvidenceReceipt) error {
	return verifyEvidenceDetailsForLedger(receiptPath, receipt, 0, time.Time{})
}

func verifyEvidenceDetailsForLedger(receiptPath string, receipt EvidenceReceipt, preparedRevision int, preparedAt time.Time) error {
	if strings.EqualFold(filepath.Base(receiptPath), receipt.DetailsPath) {
		return errors.New("release receipt and details must be different sibling files")
	}
	raw, err := securepath.ReadRegularWithin(filepath.Dir(receiptPath), receipt.DetailsPath, maxAuditJSON)
	if err != nil {
		return fmt.Errorf("read release evidence details: %w", err)
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != receipt.DetailsSHA256 {
		return errors.New("release evidence details SHA-256 does not match its sibling file")
	}
	if receipt.GateID == "packaged_blackbox" {
		var details PackagedBlackboxDetails
		if err := decodeStrict(raw, &details); err != nil {
			return fmt.Errorf("decode packaged black-box details: %w", err)
		}
		return validatePackagedBlackboxDetails(details, receipt)
	}
	switch receipt.GateID {
	case "local_source_tests", "gate0_windows_host", "rag_50000", "scheduler_recovery":
		if err := validateLocalReleaseDetails(raw, receipt); err != nil {
			return err
		}
		return reauthenticateLocalSourceTree(raw, receipt.GateID)
	case "live_auth_exact_models":
		return ValidateLiveAuthExactModelsEvidenceForLedger(raw, receipt, preparedRevision, preparedAt)
	case "live_embeddings_shadow":
		return ValidateLiveEmbeddingsShadowEvidenceForLedger(raw, receipt, preparedRevision, preparedAt)
	case "live_quality_12":
		return validateLiveEvaluationDetails(raw, receipt)
	case "live_end_to_end":
		return validateLiveEndToEndDetailsForLedger(raw, receipt, preparedRevision, preparedAt)
	case "clean_vm_installer", "clean_vm_portable":
		return validateCleanVMDetailsForLedger(raw, receipt, preparedRevision, preparedAt, filepath.Dir(receiptPath))
	case "production_update_feed":
		return validateProductionFeedDetailsForLedger(raw, receipt, preparedRevision, preparedAt)
	case "incompatible_su2_host":
		return validateIncompatibleSU2HostDetailsForLedger(raw, receipt, preparedRevision, preparedAt)
	default:
		return fmt.Errorf("release gate %q has no typed details verifier", receipt.GateID)
	}
}

func reauthenticateLocalSourceTree(raw []byte, gateID string) error {
	if !localGateUsesSourceTree(gateID) {
		return nil
	}
	var details localReleaseDetails
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode local release details for source reauthentication: %w", err)
	}
	if len(details.Commands) == 0 {
		return errors.New("local release details omit the source working directory")
	}
	seal, err := releasetree.Compute(details.Commands[0].WorkingDir)
	if err != nil {
		return fmt.Errorf("reauthenticate current release source tree: %w", err)
	}
	if seal.SHA256 != details.SourceTreeSHA256 || seal.FileCount != details.SourceFileCount {
		return errors.New("current release source tree differs from the tree observed by the local gate")
	}
	return nil
}

func validatePackagedBlackboxDetails(details PackagedBlackboxDetails, receipt EvidenceReceipt) error {
	if details.Schema != PackagedBlackboxDetailsSchemaV1 ||
		details.ReleaseCandidateID != receipt.ReleaseCandidateID ||
		!filepath.IsAbs(details.CandidateExecutable) || !strings.EqualFold(filepath.Ext(details.CandidateExecutable), ".exe") ||
		!details.IsolatedDataOnly || details.TemporaryRootRetained || details.TemporaryRoot != "" ||
		strings.TrimSpace(details.FixtureRole) == "" {
		return errors.New("packaged black-box details identity or isolation contract is invalid")
	}
	if details.Environment.OS != "windows" || details.Environment.Architecture != "amd64" ||
		strings.TrimSpace(details.Environment.GoVersion) == "" || details.Environment.LogicalProcessors < 1 ||
		!windows11Version(details.Environment.WindowsVersion) {
		return errors.New("packaged black-box environment is not a complete Windows 11 x64 observation")
	}
	identity, err := PackagedBlackboxEnvironmentIdentity(details.Environment)
	if err != nil || receipt.Environment.Class != string(EvidencePackagedBlackbox) ||
		receipt.Environment.OS != "windows-11" || receipt.Environment.Architecture != "amd64" ||
		receipt.Environment.IdentitySHA256 != identity {
		return errors.New("packaged black-box environment identity does not match its details")
	}
	requiredScenarios := map[string]struct{}{
		"forced_termination_recovery": {}, "runtime_and_sidecar_tamper": {},
		"candidate_stability": {}, "isolated_fixture_cleanup": {},
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(details.Scenarios))
	for _, scenario := range details.Scenarios {
		if _, required := requiredScenarios[scenario.ID]; !required || scenario.Status != "passed" {
			return fmt.Errorf("packaged black-box scenario %q is unknown or did not pass", scenario.ID)
		}
		if _, duplicate := seen[scenario.ID]; duplicate {
			return fmt.Errorf("packaged black-box scenario %q is duplicated", scenario.ID)
		}
		if err := validatePackagedBlackboxScenario(scenario, subjects); err != nil {
			return fmt.Errorf("packaged black-box scenario %q: %w", scenario.ID, err)
		}
		seen[scenario.ID] = struct{}{}
	}
	if len(seen) != len(requiredScenarios) {
		return errors.New("packaged black-box details omit a required scenario")
	}
	if !details.EvidenceLimits.PackagedBlackboxGateEligible || details.EvidenceLimits.ExternalGateEligible ||
		!sameStringSet(details.EvidenceLimits.Proves, []string{
			"local_packaged_executable", "crash_recovery", "runtime_tamper_rejection", "sidecar_prelaunch_identity_rejection",
		}) || !sameStringSet(details.EvidenceLimits.DoesNotProve, []string{
		"live_service", "clean_vm", "incompatible_hardware", "production_signed_feed",
	}) {
		return errors.New("packaged black-box evidence limits are incomplete or overclaim external evidence")
	}
	return nil
}

func PackagedBlackboxEnvironmentIdentity(environment PackagedBlackboxEnvironment) (string, error) {
	canonical, err := json.Marshal(environment)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	_, _ = io.WriteString(digest, packagedBlackboxEnvironmentDomain)
	_, _ = digest.Write(canonical)
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func windows11Version(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "10" || parts[1] != "0" {
		return false
	}
	build, err := strconv.Atoi(parts[2])
	return err == nil && build >= 22000
}

func sameStringSet(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	seen := make(map[string]struct{}, len(actual))
	for _, value := range actual {
		if strings.TrimSpace(value) == "" {
			return false
		}
		seen[value] = struct{}{}
	}
	if len(seen) != len(actual) {
		return false
	}
	for _, value := range expected {
		if _, ok := seen[value]; !ok {
			return false
		}
	}
	return true
}

func Verify(ledgerPath string, expectedBuild buildinfo.ProductBuildBinding, now time.Time) (AdmissionReceipt, error) {
	chain, err := loadLedgerChainState(ledgerPath)
	if err != nil {
		return AdmissionReceipt{}, err
	}
	ledger, ledgerHash := chain.Tip, chain.TipHash
	if ledger.ProductBuild != expectedBuild {
		return AdmissionReceipt{}, errors.New("release gate ledger is bound to a different product build")
	}
	if now.IsZero() {
		now = time.Now()
	}
	if ledger.PreparedAt.After(now.Add(10 * time.Minute)) {
		return AdmissionReceipt{}, errors.New("release gate ledger prepared_at is in the future")
	}
	result := AdmissionReceipt{
		Schema: AdmissionSchemaV1, ReleaseCandidateID: ledger.ReleaseCandidateID,
		ProductBuild: ledger.ProductBuild, VerifiedAt: now.UTC(), LedgerSHA256: ledgerHash,
		RequiredGates: len(RequiredGates()), Results: make([]GateResult, 0, len(RequiredGates())),
	}
	references := make(map[string]EvidenceReference, len(ledger.Evidence))
	for _, reference := range ledger.Evidence {
		references[reference.GateID] = reference
	}
	ledgerDirectory := filepath.Dir(ledgerPath)
	for _, requirement := range RequiredGates() {
		gateResult := GateResult{GateID: requirement.GateID, RequiredEvidenceKind: requirement.RequiredEvidenceKind}
		reference, exists := references[requirement.GateID]
		if !exists || strings.TrimSpace(reference.ReceiptPath) == "" {
			gateResult.Status = "not_evidenced"
			if requirement.External {
				gateResult.Status = "blocked_external"
			}
			gateResult.Failure = "required release evidence is absent"
			result.Results = append(result.Results, gateResult)
			continue
		}
		receiptName, pathErr := securepath.SiblingName(reference.ReceiptPath)
		if pathErr != nil {
			gateResult.Status, gateResult.Failure = "invalid_evidence", pathErr.Error()
			result.Results = append(result.Results, gateResult)
			continue
		}
		receiptPath := filepath.Join(ledgerDirectory, receiptName)
		raw, readErr := securepath.ReadRegularWithin(ledgerDirectory, receiptName, maxAuditJSON)
		if readErr != nil {
			gateResult.Status, gateResult.Failure = "invalid_evidence", readErr.Error()
			result.Results = append(result.Results, gateResult)
			continue
		}
		digest := sha256.Sum256(raw)
		actualDigest := hex.EncodeToString(digest[:])
		gateResult.ReceiptSHA256 = actualDigest
		if actualDigest != reference.ReceiptSHA256 {
			gateResult.Status, gateResult.Failure = "invalid_evidence", "release evidence file SHA-256 does not match ledger"
			result.Results = append(result.Results, gateResult)
			continue
		}
		var evidence EvidenceReceipt
		if decodeErr := decodeStrict(raw, &evidence); decodeErr != nil {
			gateResult.Status, gateResult.Failure = "invalid_evidence", decodeErr.Error()
			result.Results = append(result.Results, gateResult)
			continue
		}
		gateResult.ActualEvidenceKind = evidence.EvidenceKind
		if validateErr := evidence.Validate(); validateErr != nil {
			gateResult.Status, gateResult.Failure = "invalid_evidence", validateErr.Error()
		} else if evidence.GateID != requirement.GateID {
			gateResult.Status, gateResult.Failure = "invalid_evidence", "release evidence gate id does not match ledger"
		} else if evidence.ReleaseCandidateID != ledger.ReleaseCandidateID || evidence.ProductBuild != ledger.ProductBuild {
			gateResult.Status, gateResult.Failure = "invalid_evidence", "release evidence belongs to a different candidate"
		} else if evidence.EvidenceKind != requirement.RequiredEvidenceKind {
			gateResult.Status, gateResult.Failure = "invalid_evidence", "release evidence kind does not satisfy gate policy"
		} else if preparedLedgerSubject(evidence) != chain.PreparedLedgerByGateID[requirement.GateID] {
			gateResult.Status, gateResult.Failure = "invalid_evidence", "release evidence is not bound to the ledger revision immediately preceding its attachment"
		} else if evidence.ObservedAt.Before(ledger.PreparedAt) || evidence.ObservedAt.After(now.Add(10*time.Minute)) {
			gateResult.Status, gateResult.Failure = "invalid_evidence", "release evidence timestamp is outside the candidate ledger window"
		} else if detailsErr := verifyEvidenceDetailsForLedger(
			receiptPath, evidence, chain.PreparedLedgerRevisionByGateID[requirement.GateID], ledger.PreparedAt,
		); detailsErr != nil {
			gateResult.Status, gateResult.Failure = "invalid_evidence", detailsErr.Error()
		} else if evidence.Status != "passed" {
			gateResult.Status, gateResult.Failure = "failed", "evidence producer reported failure"
		} else {
			gateResult.Status = "passed"
			result.PassedGates++
		}
		result.Results = append(result.Results, gateResult)
	}
	result.Passed = result.PassedGates == result.RequiredGates
	return result, nil
}

func preparedLedgerSubject(receipt EvidenceReceipt) string {
	for _, subject := range receipt.SubjectHashes {
		if subject.Name == "prepared-ledger" {
			return subject.SHA256
		}
	}
	return ""
}

func resolveEvidencePath(ledgerDirectory, reference string) (string, error) {
	name, err := securepath.SiblingName(reference)
	if err != nil {
		return "", err
	}
	return securepath.RegularPathWithin(ledgerDirectory, name)
}

func readRegular(path string) ([]byte, error) {
	return securepath.ReadRegular(path, maxAuditJSON)
}

func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailer any
	if err := decoder.Decode(&trailer); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON input contains multiple values")
		}
		return err
	}
	return nil
}

func knownEvidenceKind(kind EvidenceKind) bool {
	switch kind {
	case EvidenceLocalIntegration, EvidencePackagedBlackbox, EvidenceLiveService,
		EvidenceLiveEvaluation, EvidenceCleanVM, EvidenceIncompatibleHardware, EvidenceProductionFeed:
		return true
	default:
		return false
	}
}

func validDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}
