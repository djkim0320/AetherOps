package releasegate

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cleanvmcontract"
	"github.com/djkim0320/Aether-claw/internal/securepath"
)

const (
	cleanVMEnvironmentDomain = "aetherops-clean-vm-environment-v1\x00"
	maxCleanVMPackageBytes   = int64(8 << 30)
)

func cleanVMRequiredSubjects() []string {
	result := []string{
		"prepared-ledger", "source-tree", "clean-vm-details", "build-host-reference",
		"installer-package", "portable-package", "package-sha256-manifest", "evaluation-dataset",
		"release-eval-runner-receipt", "release-evaluation-details",
	}
	for _, id := range cleanvmcontract.RequiredCheckIDs() {
		result = append(result, "clean-vm-observation-"+id)
	}
	return result
}

func validateCleanVMDetailsForLedger(
	raw []byte,
	receipt EvidenceReceipt,
	preparedRevision int,
	preparedAt time.Time,
	directory string,
) error {
	if receipt.Schema != EvidenceSchemaV1 ||
		(receipt.GateID != "clean_vm_installer" && receipt.GateID != "clean_vm_portable") ||
		receipt.EvidenceKind != EvidenceCleanVM || receipt.Producer != (Producer{
		Name: cleanvmcontract.ProducerName, Version: cleanvmcontract.ProducerVersion,
	}) || receipt.Status != "passed" || receipt.ObservedAt.IsZero() {
		return errors.New("clean VM evidence outer identity or producer is invalid")
	}
	var details cleanvmcontract.Details
	if err := decodeStrict(raw, &details); err != nil {
		return fmt.Errorf("decode clean VM details: %w", err)
	}
	referenceRaw, err := securepath.ReadRegularWithin(directory, details.HostReferenceFilename, cleanvmcontract.MaxObservationBytes)
	if err != nil {
		return fmt.Errorf("read clean VM build-host reference: %w", err)
	}
	var reference cleanvmcontract.HostReference
	if err := decodeStrict(referenceRaw, &reference); err != nil {
		return fmt.Errorf("decode clean VM build-host reference: %w", err)
	}
	if sha256String(referenceRaw) != details.HostReferenceSHA256 {
		return errors.New("clean VM build-host reference hash does not match details")
	}
	if err := details.Validate(reference); err != nil {
		return err
	}
	if details.GateID != receipt.GateID || details.ReleaseCandidateID != receipt.ReleaseCandidateID ||
		details.ProductBuild != receipt.ProductBuild || !details.FinishedAt.Equal(receipt.ObservedAt) {
		return errors.New("clean VM details do not match the outer receipt")
	}
	if preparedRevision > 0 && details.PreparedLedgerRevision != preparedRevision {
		return errors.New("clean VM details ledger revision does not match its immediate attachment predecessor")
	}
	if !preparedAt.IsZero() && !reference.PreparedLedgerAt.Equal(preparedAt) {
		return errors.New("clean VM build-host reference ledger timestamp does not match its attachment chain")
	}
	identity := cleanVMEnvironmentIdentity(details.Environment, reference.MachineIdentitySHA256, details.Scenario)
	if receipt.Environment != (Environment{
		Class: string(EvidenceCleanVM), OS: "windows-11", Architecture: "amd64", IdentitySHA256: identity,
	}) {
		return errors.New("clean VM receipt environment identity does not match its typed details")
	}
	subjects, err := receiptSubjectMap(receipt)
	if err != nil {
		return err
	}
	want := map[string]string{
		"aetherops.exe":               receipt.ProductBuild.ExecutableSHA256,
		"runtime-manifest.json":       receipt.ProductBuild.RuntimeManifestSHA256,
		"knowledge-sidecar-tree":      receipt.ProductBuild.KnowledgeSidecarTreeSHA256,
		"prepared-ledger":             details.PreparedLedgerSHA256,
		"source-tree":                 details.SourceTreeSHA256,
		"clean-vm-details":            receipt.DetailsSHA256,
		"build-host-reference":        details.HostReferenceSHA256,
		"installer-package":           details.Package.InstallerSHA256,
		"portable-package":            details.Package.PortableSHA256,
		"package-sha256-manifest":     details.Package.ManifestSHA256,
		"evaluation-dataset":          "",
		"release-eval-runner-receipt": details.Workflow.RunnerReceiptSHA256,
		"release-evaluation-details":  details.Workflow.QualityReceiptSHA256,
	}
	for _, artifact := range details.Artifacts {
		want["clean-vm-observation-"+artifact.Name] = artifact.SHA256
	}
	datasetHash, _, err := hashCleanVMSibling(directory, details.DatasetFilename, cleanvmcontract.MaxObservationBytes)
	if err != nil {
		return fmt.Errorf("authenticate clean VM evaluation dataset: %w", err)
	}
	want["evaluation-dataset"] = datasetHash
	if !equalSubjectSets(subjects, want) {
		return errors.New("clean VM evidence subject set is incomplete, excessive, or mismatched")
	}
	files := []struct {
		name    string
		digest  string
		bytes   int64
		maximum int64
	}{
		{details.HostReferenceFilename, details.HostReferenceSHA256, int64(len(referenceRaw)), cleanvmcontract.MaxObservationBytes},
		{details.Package.InstallerName, details.Package.InstallerSHA256, details.Package.InstallerBytes, maxCleanVMPackageBytes},
		{details.Package.PortableName, details.Package.PortableSHA256, details.Package.PortableBytes, maxCleanVMPackageBytes},
		{details.Package.ManifestName, details.Package.ManifestSHA256, 0, cleanvmcontract.MaxObservationBytes},
		{details.DatasetFilename, datasetHash, 0, cleanvmcontract.MaxObservationBytes},
		{details.RunnerReceiptFilename, details.Workflow.RunnerReceiptSHA256, 0, cleanvmcontract.MaxObservationBytes},
		{details.QualityReceiptFilename, details.Workflow.QualityReceiptSHA256, 0, cleanvmcontract.MaxObservationBytes},
	}
	seenFiles := make(map[string]struct{}, len(files)+len(details.Artifacts))
	for _, file := range files {
		if err := authenticateCleanVMFile(directory, file.name, file.digest, file.bytes, file.maximum, seenFiles); err != nil {
			return err
		}
	}
	for _, artifact := range details.Artifacts {
		if err := authenticateCleanVMFile(directory, artifact.Filename, artifact.SHA256, artifact.Bytes,
			cleanvmcontract.MaxObservationBytes, seenFiles); err != nil {
			return err
		}
	}
	return nil
}

func authenticateCleanVMFile(
	directory, name, expectedHash string,
	expectedBytes, maximum int64,
	seen map[string]struct{},
) error {
	key := strings.ToLower(name)
	if _, duplicate := seen[key]; duplicate {
		return fmt.Errorf("clean VM authenticated sibling %q is reused", name)
	}
	seen[key] = struct{}{}
	digest, size, err := hashCleanVMSibling(directory, name, maximum)
	if err != nil {
		return fmt.Errorf("authenticate clean VM sibling %q: %w", name, err)
	}
	if digest != expectedHash || (expectedBytes > 0 && size != expectedBytes) {
		return fmt.Errorf("clean VM authenticated sibling %q changed after observation", name)
	}
	return nil
}

func hashCleanVMSibling(directory, name string, maximum int64) (string, int64, error) {
	path, err := securepath.RegularPathWithin(directory, name)
	if err != nil {
		return "", 0, err
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() < 0 || before.Size() > maximum {
		return "", 0, errors.New("clean VM sibling is not a bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	digest := sha256.New()
	written, copyErr := io.Copy(digest, io.LimitReader(file, maximum+1))
	after, statErr := file.Stat()
	closeErr := file.Close()
	if copyErr != nil || statErr != nil || closeErr != nil || written != before.Size() || written > maximum ||
		!os.SameFile(before, after) || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return "", 0, errors.New("clean VM sibling changed while hashing")
	}
	return hex.EncodeToString(digest.Sum(nil)), written, nil
}

func cleanVMEnvironmentIdentity(environment cleanvmcontract.VMEnvironment, hostIdentity, scenario string) string {
	return sha256String([]byte(cleanVMEnvironmentDomain + environment.MachineIdentitySHA256 + "\x00" + hostIdentity + "\x00" + scenario))
}

func sha256String(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func equalSubjectSets(actual, expected map[string]string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for name, digest := range expected {
		if actual[name] != digest {
			return false
		}
	}
	return true
}
