package cleanvmevidence

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
	"github.com/djkim0320/Aether-claw/internal/releasegate"
	"github.com/djkim0320/Aether-claw/internal/releasetree"
	"github.com/djkim0320/Aether-claw/internal/securepath"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	maxJSONBytes       = 8 << 20
	maxArtifactBytes   = 1 << 30
	maxPortableEntries = 100_000
	maxPortableBytes   = 8 << 30
)

type HostReferenceConfig struct {
	PreparedLedgerPath string
	SourceRoot         string
	OutputPath         string
	Now                time.Time
}

type FinalizeConfig struct {
	PreparedLedgerPath string
	HostReferencePath  string
	CampaignDraftPath  string
	InstallerPath      string
	PortablePath       string
	PackageManifest    string
	DatasetPath        string
	RunnerReceiptPath  string
	QualityReceiptPath string
	OutputPath         string
	Now                time.Time
}

func CaptureHostReference(config HostReferenceConfig) (HostReference, error) {
	ledger, ledgerSHA256, err := releasegate.LoadLedgerChain(strings.TrimSpace(config.PreparedLedgerPath))
	if err != nil {
		return HostReference{}, fmt.Errorf("load prepared ledger: %w", err)
	}
	seal, err := releasetree.Compute(strings.TrimSpace(config.SourceRoot))
	if err != nil {
		return HostReference{}, fmt.Errorf("compute release source seal: %w", err)
	}
	machineIdentity, windowsVersion, err := CaptureHostIdentity(config.Now)
	if err != nil {
		return HostReference{}, err
	}
	now := config.Now
	if now.IsZero() {
		now = time.Now()
	}
	reference := HostReference{
		Schema: HostReferenceSchemaV1, ReleaseCandidateID: ledger.ReleaseCandidateID,
		ProductBuild: ledger.ProductBuild, PreparedLedgerSHA256: ledgerSHA256,
		PreparedLedgerRevision: ledger.Revision, PreparedLedgerAt: ledger.PreparedAt, SourceTreeSHA256: seal.SHA256,
		SourceTreeFiles: seal.FileCount, MachineIdentitySHA256: machineIdentity,
		OS: "windows-11", Architecture: "amd64", WindowsVersion: windowsVersion,
		CapturedAt: now.UTC(),
	}
	if reference.CapturedAt.Before(ledger.PreparedAt) {
		return HostReference{}, errors.New("host reference predates the prepared ledger")
	}
	if err := reference.Validate(); err != nil {
		return HostReference{}, err
	}
	if err := writeJSONExclusive(config.OutputPath, reference); err != nil {
		return HostReference{}, err
	}
	return reference, nil
}

func Finalize(config FinalizeConfig) (releasegate.EvidenceReceipt, error) {
	ledger, ledgerSHA256, err := releasegate.LoadLedgerChain(strings.TrimSpace(config.PreparedLedgerPath))
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load prepared ledger: %w", err)
	}
	output, detailsOutput, err := validateOutputLayout(config)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	var reference HostReference
	referenceRaw, err := readRegularJSON(config.HostReferencePath, maxJSONBytes, &reference)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load host reference: %w", err)
	}
	if err := reference.Validate(); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if reference.ReleaseCandidateID != ledger.ReleaseCandidateID || reference.ProductBuild != ledger.ProductBuild ||
		reference.PreparedLedgerSHA256 != ledgerSHA256 || reference.PreparedLedgerRevision != ledger.Revision {
		return releasegate.EvidenceReceipt{}, errors.New("host reference is not bound to the exact current prepared ledger")
	}
	var details Details
	if _, err := readRegularJSON(config.CampaignDraftPath, maxJSONBytes, &details); err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load clean VM campaign draft: %w", err)
	}
	referenceHash := sha256Hex(referenceRaw)
	details.HostReferenceSHA256 = referenceHash
	details.HostReferenceFilename = filepath.Base(config.HostReferencePath)
	details.DatasetFilename = filepath.Base(config.DatasetPath)
	details.RunnerReceiptFilename = filepath.Base(config.RunnerReceiptPath)
	details.QualityReceiptFilename = filepath.Base(config.QualityReceiptPath)
	if details.PreparedLedgerSHA256 != ledgerSHA256 || details.PreparedLedgerRevision != ledger.Revision {
		return releasegate.EvidenceReceipt{}, errors.New("clean VM campaign draft is not bound to the exact current prepared ledger")
	}
	if !ledgerGateOpen(ledger, details.GateID) {
		return releasegate.EvidenceReceipt{}, errors.New("clean VM gate is unknown or already has immutable evidence")
	}
	current, err := CaptureEnvironment(config.Now)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if current.MachineIdentitySHA256 != details.Environment.MachineIdentitySHA256 ||
		current.CurrentUserSIDHash != details.Environment.CurrentUserSIDHash ||
		current.WindowsVersion != details.Environment.WindowsVersion {
		return releasegate.EvidenceReceipt{}, errors.New("campaign finalization is running on a different Windows VM or user")
	}
	installerHash, installerBytes, err := hashRegularFile(config.InstallerPath, maxArtifactBytes)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("hash installer: %w", err)
	}
	portableHash, portableBytes, err := hashRegularFile(config.PortablePath, maxArtifactBytes)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("hash portable ZIP: %w", err)
	}
	manifestHash, _, err := hashRegularFile(config.PackageManifest, maxJSONBytes)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("hash package manifest: %w", err)
	}
	if err := verifyPackageManifest(config.PackageManifest, config.InstallerPath, installerHash, config.PortablePath, portableHash); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	portableBuild, err := bindPortableBuild(config.PortablePath)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("verify portable candidate: %w", err)
	}
	if portableBuild != ledger.ProductBuild {
		return releasegate.EvidenceReceipt{}, errors.New("portable archive contains a different product candidate")
	}
	if details.Package.ManifestName != filepath.Base(config.PackageManifest) || details.Package.ManifestSHA256 != manifestHash || details.Package.InstallerSHA256 != installerHash ||
		details.Package.PortableSHA256 != portableHash || details.Package.InstallerBytes != installerBytes ||
		details.Package.PortableBytes != portableBytes || details.Package.InstallerName != filepath.Base(config.InstallerPath) ||
		details.Package.PortableName != filepath.Base(config.PortablePath) || details.Package.ObservedProductBuild != portableBuild {
		return releasegate.EvidenceReceipt{}, errors.New("campaign package observation does not match the selected release artifacts")
	}
	dataset, err := evalgate.LoadDataset(strings.TrimSpace(config.DatasetPath))
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load exact quality dataset: %w", err)
	}
	runner, err := evalrunner.LoadReceipt(strings.TrimSpace(config.RunnerReceiptPath), dataset, ledger.ProductBuild)
	if err != nil {
		return releasegate.EvidenceReceipt{}, fmt.Errorf("load live runner receipt: %w", err)
	}
	runnerRaw, err := readRegular(config.RunnerReceiptPath, maxJSONBytes)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	qualityRaw, err := readRegular(config.QualityReceiptPath, maxJSONBytes)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if err := validateQualityReceipt(qualityRaw, dataset, runner, ledger.ProductBuild); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if details.Workflow.RunnerReceiptSHA256 != sha256Hex(runnerRaw) ||
		details.Workflow.QualityReceiptSHA256 != sha256Hex(qualityRaw) || details.Workflow.EvalRunSetID != runner.EvalRunSetID {
		return releasegate.EvidenceReceipt{}, errors.New("clean VM workflow is not bound to the live runner and offline quality receipts")
	}
	artifactSubjects, err := authenticateObservationArtifacts(filepath.Dir(output), details, runner)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if err := details.Validate(reference); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	now := config.Now
	if now.IsZero() {
		now = time.Now()
	}
	if details.FinishedAt.After(now.UTC().Add(10 * time.Minute)) {
		return releasegate.EvidenceReceipt{}, errors.New("clean VM campaign finishes in the future")
	}
	currentLedger, currentLedgerSHA256, err := releasegate.LoadLedgerChain(strings.TrimSpace(config.PreparedLedgerPath))
	if err != nil || currentLedgerSHA256 != ledgerSHA256 || currentLedger.ReleaseCandidateID != ledger.ReleaseCandidateID ||
		currentLedger.Revision != ledger.Revision {
		return releasegate.EvidenceReceipt{}, errors.New("prepared ledger changed during clean VM finalization")
	}
	detailsRaw, err := marshalJSON(details)
	if err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	if err := writeBytesExclusive(detailsOutput, detailsRaw); err != nil {
		return releasegate.EvidenceReceipt{}, err
	}
	detailsHash := sha256Hex(detailsRaw)
	baseSubjects := []releasegate.SubjectHash{
		{Name: "aetherops.exe", SHA256: ledger.ProductBuild.ExecutableSHA256},
		{Name: "runtime-manifest.json", SHA256: ledger.ProductBuild.RuntimeManifestSHA256},
		{Name: "knowledge-sidecar-tree", SHA256: ledger.ProductBuild.KnowledgeSidecarTreeSHA256},
		{Name: "prepared-ledger", SHA256: ledgerSHA256},
		{Name: "source-tree", SHA256: reference.SourceTreeSHA256},
		{Name: "clean-vm-details", SHA256: detailsHash},
		{Name: "build-host-reference", SHA256: referenceHash},
		{Name: "installer-package", SHA256: installerHash},
		{Name: "portable-package", SHA256: portableHash},
		{Name: "package-sha256-manifest", SHA256: manifestHash},
		{Name: "evaluation-dataset", SHA256: dataset.SHA256},
		{Name: "release-eval-runner-receipt", SHA256: sha256Hex(runnerRaw)},
		{Name: "release-evaluation-details", SHA256: sha256Hex(qualityRaw)},
	}
	baseSubjects = append(baseSubjects, artifactSubjects...)
	sort.Slice(baseSubjects, func(i, j int) bool { return baseSubjects[i].Name < baseSubjects[j].Name })
	environmentIdentity := sha256Hex([]byte("aetherops-clean-vm-environment-v1\x00" +
		details.Environment.MachineIdentitySHA256 + "\x00" + reference.MachineIdentitySHA256 + "\x00" + details.Scenario))
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: details.GateID,
		EvidenceKind: releasegate.EvidenceCleanVM, ReleaseCandidateID: ledger.ReleaseCandidateID,
		ProductBuild: ledger.ProductBuild,
		Producer:     releasegate.Producer{Name: ProducerName, Version: ProducerVersion},
		Environment:  releasegate.Environment{Class: string(releasegate.EvidenceCleanVM), OS: "windows-11", Architecture: "amd64", IdentitySHA256: environmentIdentity},
		ObservedAt:   details.FinishedAt, Status: "passed", SubjectHashes: baseSubjects,
		DetailsPath: filepath.Base(detailsOutput), DetailsSHA256: detailsHash,
	}
	if err := writeJSONExclusive(output, receipt); err != nil {
		_ = os.Remove(detailsOutput)
		return releasegate.EvidenceReceipt{}, err
	}
	return receipt, nil
}

func validateQualityReceipt(raw []byte, dataset evalgate.Dataset, runner evalrunner.Receipt, build buildinfo.ProductBuildBinding) error {
	var receipt evalgate.Receipt
	if err := decodeStrict(raw, &receipt); err != nil {
		return fmt.Errorf("decode release quality receipt: %w", err)
	}
	if receipt.Schema != evalgate.ReceiptSchemaV3 || receipt.ExecutionSource != evalgate.RunnerExecutionSource ||
		receipt.ProductBuild != build || receipt.DatasetName != dataset.Name || receipt.DatasetSHA256 != dataset.SHA256 ||
		receipt.EvalRunSetID != runner.EvalRunSetID || receipt.RunnerReceiptSHA256 != runner.SHA256 ||
		!receipt.Passed || receipt.RequiredCases != 12 || receipt.RequiredPasses != 12 || receipt.ObservedPasses != 12 ||
		len(receipt.Results) != 12 || receipt.VerifiedAt.IsZero() {
		return errors.New("release quality receipt is not a passed 12/12 runner-bound result for the exact candidate")
	}
	seen := map[string]struct{}{}
	runnerByCase := make(map[string]evalrunner.CaseReceipt, len(runner.Cases))
	for _, item := range runner.Cases {
		runnerByCase[item.DatasetCaseID] = item
	}
	for _, result := range receipt.Results {
		observed, runnerFound := runnerByCase[result.CaseID]
		if strings.TrimSpace(result.CaseID) == "" || strings.TrimSpace(result.RunID) == "" || !runnerFound || observed.RunID != result.RunID ||
			!result.Passed || result.Status != core.RunSucceeded || result.ResearchProfileVersion != core.CurrentResearchProfileVersion ||
			result.RetrievalProfile != store.DefaultRetrievalProfile || strings.TrimSpace(result.KnowledgeGenerationID) == "" ||
			strings.TrimSpace(result.MaterializedGenerationID) == "" ||
			result.CitationIntegrityPercent != 100 || result.KnowledgeEvidenceIntegrityPercent != 100 ||
			result.UnsupportedAssertions != 0 || result.CriticalErrorCount != 0 || result.AverageScore < 4 {
			return fmt.Errorf("release quality case %q did not pass every quality and knowledge gate", result.CaseID)
		}
		if _, duplicate := seen[result.CaseID]; duplicate {
			return errors.New("release quality receipt duplicates a case")
		}
		seen[result.CaseID] = struct{}{}
		for _, score := range result.Scores.Values() {
			if score < 3 || score > 5 {
				return fmt.Errorf("release quality case %q has an out-of-policy review axis", result.CaseID)
			}
		}
	}
	for _, item := range dataset.Cases {
		if _, ok := seen[item.ID]; !ok {
			return fmt.Errorf("release quality receipt is missing dataset case %q", item.ID)
		}
	}
	return nil
}

func ledgerGateOpen(ledger releasegate.Ledger, gateID string) bool {
	for _, reference := range ledger.Evidence {
		if reference.GateID == gateID {
			return reference.ReceiptPath == "" && reference.ReceiptSHA256 == ""
		}
	}
	return false
}

func authenticateObservationArtifacts(directory string, details Details, runner evalrunner.Receipt) ([]releasegate.SubjectHash, error) {
	result := make([]releasegate.SubjectHash, 0, len(details.Artifacts))
	for _, artifact := range details.Artifacts {
		if filepath.Base(artifact.Filename) != artifact.Filename || artifact.Filename == "." || artifact.Filename == ".." {
			return nil, fmt.Errorf("observation artifact %q is not a direct sibling", artifact.Name)
		}
		hash, size, err := hashRegularFile(filepath.Join(directory, artifact.Filename), maxJSONBytes)
		if err != nil {
			return nil, fmt.Errorf("authenticate observation artifact %q: %w", artifact.Name, err)
		}
		if hash != artifact.SHA256 || size != artifact.Bytes {
			return nil, fmt.Errorf("observation artifact %q changed after capture", artifact.Name)
		}
		raw, err := readRegular(filepath.Join(directory, artifact.Filename), maxJSONBytes)
		if err != nil {
			return nil, err
		}
		switch artifact.Name {
		case "solver_receipt":
			if err := validateSolverReceipt(raw, runner); err != nil {
				return nil, err
			}
		case "rdf_import":
			if err := validateRDFSnapshotReceipt(raw); err != nil {
				return nil, err
			}
		case "sparql_read":
			if err := validateSPARQLResult(raw); err != nil {
				return nil, err
			}
		case "graph_edit":
			if err := validateGraphEditEvent(raw, details.Workflow.ProjectIDHash); err != nil {
				return nil, err
			}
		}
		result = append(result, releasegate.SubjectHash{Name: "clean-vm-observation-" + artifact.Name, SHA256: hash})
	}
	return result, nil
}

type solverReceipt struct {
	Schema         int                      `json:"schema"`
	JobID          string                   `json:"job_id"`
	RunID          string                   `json:"run_id"`
	StageAttemptID string                   `json:"stage_attempt_id"`
	Operation      string                   `json:"operation"`
	Spec           json.RawMessage          `json:"spec"`
	SpecSHA256     string                   `json:"spec_sha256"`
	Executables    []solverExecutable       `json:"executables"`
	Threads        int                      `json:"threads"`
	StartedAt      time.Time                `json:"started_at"`
	CompletedAt    time.Time                `json:"completed_at"`
	ExitCodes      []int                    `json:"exit_codes"`
	Executed       bool                     `json:"executed"`
	Numerical      bool                     `json:"numerically_valid"`
	Metrics        map[string]any           `json:"metrics"`
	Artifacts      []solverArtifactMetadata `json:"artifacts"`
}

type solverExecutable struct {
	Component string   `json:"component"`
	Version   string   `json:"version"`
	SHA256    string   `json:"sha256"`
	Argv      []string `json:"argv"`
}

type solverArtifactMetadata struct {
	ArtifactID string `json:"artifact_id"`
	Role       string `json:"role"`
	FileName   string `json:"file_name"`
	MediaType  string `json:"media_type"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
}

func validateSolverReceipt(raw []byte, runner evalrunner.Receipt) error {
	var receipt solverReceipt
	if err := decodeStrict(raw, &receipt); err != nil {
		return fmt.Errorf("decode clean VM SU2 receipt: %w", err)
	}
	if receipt.Schema != 1 || strings.TrimSpace(receipt.JobID) == "" || strings.TrimSpace(receipt.StageAttemptID) == "" ||
		receipt.Operation != "su2_naca0012" || !receipt.Executed || !receipt.Numerical || receipt.Threads < 1 ||
		receipt.StartedAt.IsZero() || !receipt.CompletedAt.After(receipt.StartedAt) || !validDigest(receipt.SpecSHA256) ||
		len(receipt.Spec) == 0 || !json.Valid(receipt.Spec) || len(receipt.Metrics) == 0 || len(receipt.Artifacts) < 3 {
		return errors.New("clean VM SU2 receipt is incomplete or not a numerically valid execution")
	}
	knownRun := false
	for _, item := range runner.Cases {
		if item.RunID == receipt.RunID && strings.HasPrefix(item.DatasetCaseID, "engineering-") {
			knownRun = true
			break
		}
	}
	if !knownRun {
		return errors.New("clean VM SU2 receipt is not bound to an engineering evaluation run")
	}
	if len(receipt.ExitCodes) != 2 {
		return errors.New("clean VM SU2 receipt does not contain Gmsh and SU2 exit codes")
	}
	for _, code := range receipt.ExitCodes {
		if code != 0 {
			return errors.New("clean VM SU2 receipt contains a failed process")
		}
	}
	components := map[string]bool{"gmsh": false, "su2": false}
	for _, executable := range receipt.Executables {
		if _, required := components[executable.Component]; required && strings.TrimSpace(executable.Version) != "" &&
			validDigest(executable.SHA256) && len(executable.Argv) > 0 {
			components[executable.Component] = true
		}
	}
	if !components["gmsh"] || !components["su2"] {
		return errors.New("clean VM SU2 receipt lacks authenticated Gmsh or SU2 executable provenance")
	}
	roles := map[string]bool{"mesh": false, "history": false, "log": false}
	for _, artifact := range receipt.Artifacts {
		if strings.TrimSpace(artifact.ArtifactID) == "" || strings.TrimSpace(artifact.FileName) == "" ||
			strings.TrimSpace(artifact.MediaType) == "" || !validDigest(artifact.SHA256) || artifact.Size <= 0 {
			return errors.New("clean VM SU2 receipt has invalid output artifact provenance")
		}
		if _, ok := roles[artifact.Role]; ok {
			roles[artifact.Role] = true
		}
	}
	if !roles["mesh"] || !roles["history"] || !roles["log"] {
		return errors.New("clean VM SU2 receipt lacks mesh, convergence history, or solver log")
	}
	return nil
}

func validateRDFSnapshotReceipt(raw []byte) error {
	var receipt store.KnowledgeSnapshotReceipt
	if err := decodeStrict(raw, &receipt); err != nil {
		return fmt.Errorf("decode clean VM RDF snapshot receipt: %w", err)
	}
	if strings.TrimSpace(receipt.ID) == "" || !validDigest(receipt.BlobHash) ||
		!validDigest(receipt.DatasetSHA256) || receipt.BlobHash != receipt.DatasetSHA256 || receipt.TripleCount <= 0 {
		return errors.New("clean VM RDF snapshot receipt is incomplete or not content-addressed")
	}
	return nil
}

func validateSPARQLResult(raw []byte) error {
	var result core.SPARQLResult
	if err := decodeStrict(raw, &result); err != nil {
		return fmt.Errorf("decode clean VM SPARQL result: %w", err)
	}
	forms := map[string]bool{"SELECT": true, "ASK": true, "CONSTRUCT": true, "DESCRIBE": true}
	if !forms[strings.ToUpper(result.QueryForm)] || !result.Complete || len(result.Result) == 0 || !json.Valid(result.Result) || string(result.Result) == "null" {
		return errors.New("clean VM SPARQL observation is partial or invalid")
	}
	return nil
}

func validateGraphEditEvent(raw []byte, projectIDHash string) error {
	var event core.CurationEvent
	if err := decodeStrict(raw, &event); err != nil {
		return fmt.Errorf("decode clean VM graph edit event: %w", err)
	}
	validKinds := map[string]bool{
		"add_entity": true, "add_assertion": true, "update_assertion": true,
		"merge_entities": true, "split_entity": true, "retract_assertion": true,
		"restore_assertion": true, "add_alias": true, "pin_entity": true,
		"resolve_conflict": true, "dismiss_conflict": true,
	}
	if event.Sequence <= 0 || strings.TrimSpace(event.ID) == "" || strings.TrimSpace(event.ProjectID) == "" ||
		strings.TrimSpace(event.GenerationID) == "" || !validKinds[event.Kind] || event.Actor != "user" ||
		len(event.Payload) == 0 || !json.Valid(event.Payload) || !validDigest(event.PayloadSHA256) ||
		!validDigest(event.EventSHA256) || event.CreatedAt.IsZero() || sha256Hex([]byte(event.ProjectID)) != projectIDHash {
		return errors.New("clean VM graph edit is not an append-only user curation event for the observed project")
	}
	if event.Sequence > 1 && !validDigest(event.PreviousEventSHA256) {
		return errors.New("clean VM graph edit event breaks the curation hash chain")
	}
	return nil
}

func verifyPackageManifest(path, installerPath, installerHash, portablePath, portableHash string) error {
	raw, err := readRegular(path, maxJSONBytes)
	if err != nil {
		return err
	}
	want := map[string]string{filepath.Base(installerPath): installerHash, filepath.Base(portablePath): portableHash}
	seen := map[string]struct{}{}
	normalized := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if strings.Contains(normalized, "\r") || !strings.HasSuffix(normalized, "\n") || strings.HasSuffix(normalized, "\n\n") {
		return errors.New("package SHA-256 manifest must be canonical two-line UTF-8 text")
	}
	lines := strings.Split(strings.TrimSuffix(normalized, "\n"), "\n")
	if len(lines) != 2 {
		return errors.New("package SHA-256 manifest must contain exactly two lines")
	}
	for _, line := range lines {
		parts := strings.SplitN(line, "  ", 2)
		if len(parts) != 2 || !validDigest(parts[0]) || filepath.Base(parts[1]) != parts[1] {
			return errors.New("package SHA-256 manifest has an invalid line")
		}
		expected, ok := want[parts[1]]
		if !ok || expected != parts[0] {
			return errors.New("package SHA-256 manifest names an unexpected or changed artifact")
		}
		if _, duplicate := seen[parts[1]]; duplicate {
			return errors.New("package SHA-256 manifest duplicates an artifact")
		}
		seen[parts[1]] = struct{}{}
	}
	if len(seen) != 2 {
		return errors.New("package SHA-256 manifest must contain exactly installer and portable artifacts")
	}
	return nil
}

func bindPortableBuild(path string) (buildinfo.ProductBuildBinding, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return buildinfo.ProductBuildBinding{}, err
	}
	defer reader.Close()
	if len(reader.File) == 0 || len(reader.File) > maxPortableEntries {
		return buildinfo.ProductBuildBinding{}, errors.New("portable ZIP entry count is invalid")
	}
	required := map[string][]byte{}
	wanted := map[string]struct{}{
		"aetherops.exe": {}, "runtime-manifest.json": {},
		"knowledge-sidecar/index.cjs": {}, "knowledge-sidecar/protocol.cjs": {}, "knowledge-sidecar/worker.cjs": {},
	}
	seen := map[string]struct{}{}
	var total uint64
	for _, entry := range reader.File {
		name := strings.ReplaceAll(entry.Name, "\\", "/")
		clean := filepath.ToSlash(filepath.Clean(name))
		if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, ":") || clean == ".." || strings.HasPrefix(clean, "../") ||
			entry.Mode()&os.ModeSymlink != 0 {
			return buildinfo.ProductBuildBinding{}, errors.New("portable ZIP contains an unsafe path or link")
		}
		key := strings.ToLower(strings.TrimSuffix(clean, "/"))
		if _, duplicate := seen[key]; duplicate {
			return buildinfo.ProductBuildBinding{}, errors.New("portable ZIP contains a case-insensitive duplicate path")
		}
		seen[key] = struct{}{}
		total += entry.UncompressedSize64
		if total > maxPortableBytes {
			return buildinfo.ProductBuildBinding{}, errors.New("portable ZIP expands beyond the size limit")
		}
		if _, ok := wanted[clean]; !ok {
			continue
		}
		if entry.FileInfo().IsDir() || !entry.Mode().IsRegular() || entry.UncompressedSize64 > maxArtifactBytes {
			return buildinfo.ProductBuildBinding{}, fmt.Errorf("portable candidate file %s is invalid", clean)
		}
		stream, err := entry.Open()
		if err != nil {
			return buildinfo.ProductBuildBinding{}, err
		}
		raw, readErr := io.ReadAll(io.LimitReader(stream, int64(entry.UncompressedSize64)+1))
		closeErr := stream.Close()
		if readErr != nil || closeErr != nil || uint64(len(raw)) != entry.UncompressedSize64 {
			return buildinfo.ProductBuildBinding{}, fmt.Errorf("portable candidate file %s changed while reading", clean)
		}
		required[clean] = raw
	}
	if len(required) != len(wanted) {
		return buildinfo.ProductBuildBinding{}, errors.New("portable ZIP is missing candidate identity files")
	}
	temporary, err := os.MkdirTemp("", "AetherOps-CleanVM-Portable-*")
	if err != nil {
		return buildinfo.ProductBuildBinding{}, err
	}
	defer os.RemoveAll(temporary)
	for name, raw := range required {
		output := filepath.Join(temporary, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
			return buildinfo.ProductBuildBinding{}, err
		}
		if err := os.WriteFile(output, raw, 0o600); err != nil {
			return buildinfo.ProductBuildBinding{}, err
		}
	}
	return buildinfo.BindProductBuild(filepath.Join(temporary, "aetherops.exe"), filepath.Join(temporary, "runtime-manifest.json"), filepath.Join(temporary, "knowledge-sidecar", "index.cjs"))
}

func validateOutputLayout(config FinalizeConfig) (string, string, error) {
	output, err := filepath.Abs(strings.TrimSpace(config.OutputPath))
	if err != nil || filepath.Ext(output) != ".json" {
		return "", "", errors.New("clean VM evidence output must be a new JSON file")
	}
	directory := filepath.Dir(output)
	ledger, err := filepath.Abs(config.PreparedLedgerPath)
	if err != nil || !strings.EqualFold(directory, filepath.Dir(ledger)) {
		return "", "", errors.New("clean VM receipt must be a direct sibling of the prepared ledger")
	}
	for _, path := range []string{config.HostReferencePath, config.InstallerPath, config.PortablePath, config.PackageManifest, config.DatasetPath,
		config.RunnerReceiptPath, config.QualityReceiptPath} {
		absolute, absoluteErr := filepath.Abs(path)
		if absoluteErr != nil || !strings.EqualFold(directory, filepath.Dir(absolute)) {
			return "", "", errors.New("clean VM authenticated inputs must be direct ledger siblings")
		}
	}
	details := strings.TrimSuffix(output, filepath.Ext(output)) + ".details.json"
	for _, path := range []string{output, details} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			return "", "", errors.New("clean VM evidence outputs already exist or cannot be inspected")
		}
	}
	return output, details, nil
}

func readRegularJSON(path string, maximum int64, target any) ([]byte, error) {
	raw, err := readRegular(path, maximum)
	if err != nil {
		return nil, err
	}
	if err := decodeStrict(raw, target); err != nil {
		return nil, err
	}
	return raw, nil
}

func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("JSON input contains trailing data")
	}
	return nil
}

func readRegular(path string, maximum int64) ([]byte, error) {
	return securepath.ReadRegular(path, maximum)
}

func hashRegularFile(path string, maximum int64) (string, int64, error) {
	validated, err := securepath.RegularPath(path)
	if err != nil {
		return "", 0, err
	}
	before, err := os.Lstat(validated)
	if err != nil || !before.Mode().IsRegular() || before.Size() < 0 || before.Size() > maximum {
		return "", 0, errors.New("input is not a bounded regular file")
	}
	file, err := os.Open(validated)
	if err != nil {
		return "", 0, err
	}
	digest := sha256.New()
	written, copyErr := io.Copy(digest, io.LimitReader(file, maximum+1))
	after, statErr := file.Stat()
	closeErr := file.Close()
	if copyErr != nil || statErr != nil || closeErr != nil || written != before.Size() || written > maximum ||
		!os.SameFile(before, after) || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return "", 0, errors.New("input changed while hashing")
	}
	return hex.EncodeToString(digest.Sum(nil)), written, nil
}

func sha256Hex(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func marshalJSON(value any) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

func writeJSONExclusive(path string, value any) error {
	raw, err := marshalJSON(value)
	if err != nil {
		return err
	}
	return writeBytesExclusive(path, raw)
}

func writeBytesExclusive(path string, raw []byte) error {
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return err
	}
	if info, err := os.Stat(filepath.Dir(absolute)); err != nil || !info.IsDir() {
		return errors.New("output parent must be an existing directory")
	}
	file, err := os.OpenFile(absolute, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		_ = file.Close()
		if !committed {
			_ = os.Remove(absolute)
		}
	}()
	if _, err := file.Write(raw); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	committed = true
	return nil
}
