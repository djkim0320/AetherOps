//go:build windows

// productionfeedevidence is the only trusted producer for the external
// production_update_feed release gate. It cannot run with fixtures: its
// production path requires the exact candidate's embedded trust, a public
// system-TLS endpoint on port 443, live downloads, and live compatibility
// probes before restart activation.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/djkim0320/AetherOps/internal/desktop"
	"github.com/djkim0320/AetherOps/internal/evalgate"
	"github.com/djkim0320/AetherOps/internal/productionfeed"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	"github.com/djkim0320/AetherOps/internal/securepath"
)

const producerVersion = "1"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps production feed evidence:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("productionfeedevidence", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	preparedLedger := flags.String("prepared-ledger", "", "exact current prepared release ledger")
	executable := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact candidate aetherops.exe")
	trustConfig := flags.String("trust-config", "", "production feed public trust JSON (no signing key)")
	browserEndpoint := flags.String("browser-endpoint", "", "actual internet WebView2 CDP endpoint: http://127.0.0.1:<port>")
	codexHome := flags.String("codex-home", "", "dedicated AetherOps CODEX_HOME used by the live App Server probe")
	detailsOut := flags.String("details-out", "", "new direct ledger-sibling .details.json path")
	receiptOut := flags.String("receipt-out", "", "new direct ledger-sibling receipt JSON path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	required := []struct{ name, value string }{
		{"-prepared-ledger", *preparedLedger}, {"-trust-config", *trustConfig},
		{"-browser-endpoint", *browserEndpoint}, {"-codex-home", *codexHome},
		{"-details-out", *detailsOut}, {"-receipt-out", *receiptOut},
	}
	for _, input := range required {
		if strings.TrimSpace(input.value) == "" {
			return fmt.Errorf("%s is required", input.name)
		}
	}
	ledgerPath, detailsPath, receiptPath, err := authenticateOutputPaths(*preparedLedger, *detailsOut, *receiptOut)
	if err != nil {
		return err
	}
	ledgerBefore, ledgerSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil {
		return fmt.Errorf("authenticate prepared ledger chain: %w", err)
	}
	buildBefore, err := productionfeed.AuthenticateCandidate(*executable)
	if err != nil {
		return err
	}
	if buildBefore != ledgerBefore.ProductBuild {
		return errors.New("candidate executable does not match prepared ledger")
	}

	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return fmt.Errorf("create production compatibility-probe Job Object: %w", err)
	}
	defer supervisor.Close()
	operationContext, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()
	result, err := productionfeed.Run(operationContext, productionfeed.Config{
		CandidateExecutable: *executable, PreparedLedger: ledgerPath, TrustConfigPath: *trustConfig,
		BrowserEndpoint: *browserEndpoint, CodexHome: *codexHome, AfterStart: supervisor.Assign,
	})
	if err != nil {
		return err
	}
	detailsRaw, err := json.MarshalIndent(result.Details, "", "  ")
	if err != nil {
		return err
	}
	detailsRaw = append(detailsRaw, '\n')
	detailsDigest := sha256.Sum256(detailsRaw)
	detailsSHA256 := hex.EncodeToString(detailsDigest[:])
	result.SubjectHashes["production-feed-details"] = detailsSHA256
	receipt := releasegate.EvidenceReceipt{
		Schema: releasegate.EvidenceSchemaV1, GateID: "production_update_feed",
		EvidenceKind: releasegate.EvidenceProductionFeed, ReleaseCandidateID: ledgerBefore.ReleaseCandidateID,
		ProductBuild: buildBefore, Producer: releasegate.Producer{Name: "cmd/productionfeedevidence", Version: producerVersion},
		Environment: releasegate.Environment{
			Class: string(releasegate.EvidenceProductionFeed), OS: "windows-11", Architecture: "amd64",
			IdentitySHA256: result.EnvironmentID,
		},
		ObservedAt: result.Details.ObservationFinishedAt, Status: "passed",
		SubjectHashes: subjectHashList(result.SubjectHashes), DetailsPath: filepath.Base(detailsPath), DetailsSHA256: detailsSHA256,
	}
	if err := receipt.Validate(); err != nil {
		return fmt.Errorf("validate typed production feed receipt before publication: %w", err)
	}
	if err := evalgate.WriteJSONNew(detailsPath, result.Details); err != nil {
		return fmt.Errorf("publish production feed details: %w", err)
	}
	publishedDetails, err := securepath.ReadRegular(detailsPath, 4<<20)
	if err != nil || !bytes.Equal(publishedDetails, detailsRaw) {
		return errors.New("published production feed details failed exact readback")
	}
	ledgerAfter, ledgerAfterSHA256, err := releasegate.LoadLedgerChain(ledgerPath)
	if err != nil || ledgerAfterSHA256 != ledgerSHA256 || ledgerAfter.ProductBuild != ledgerBefore.ProductBuild {
		return errors.New("prepared ledger changed before production feed receipt publication")
	}
	buildAfter, err := productionfeed.AuthenticateCandidate(*executable)
	if err != nil || buildAfter != buildBefore {
		return errors.New("candidate changed before production feed receipt publication")
	}
	if err := evalgate.WriteJSONNew(receiptPath, receipt); err != nil {
		return fmt.Errorf("publish production feed receipt: %w", err)
	}
	return nil
}

func authenticateOutputPaths(ledger, details, receipt string) (string, string, string, error) {
	ledgerPath, err := securepath.RegularPath(strings.TrimSpace(ledger))
	if err != nil {
		return "", "", "", fmt.Errorf("authenticate prepared ledger: %w", err)
	}
	root := filepath.Dir(ledgerPath)
	resolveNew := func(value, suffix string) (string, error) {
		absolute, err := filepath.Abs(strings.TrimSpace(value))
		if err != nil {
			return "", err
		}
		name, err := securepath.SiblingName(filepath.Base(absolute))
		if err != nil || !strings.EqualFold(filepath.Dir(absolute), root) || !strings.HasSuffix(strings.ToLower(name), suffix) {
			return "", errors.New("output must be a new direct prepared-ledger sibling with the required suffix")
		}
		if _, err := os.Lstat(absolute); err == nil {
			return "", errors.New("output already exists")
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		return absolute, nil
	}
	detailsPath, err := resolveNew(details, ".details.json")
	if err != nil {
		return "", "", "", fmt.Errorf("validate details output: %w", err)
	}
	receiptPath, err := resolveNew(receipt, ".receipt.json")
	if err != nil {
		return "", "", "", fmt.Errorf("validate receipt output: %w", err)
	}
	if strings.EqualFold(detailsPath, receiptPath) {
		return "", "", "", errors.New("details and receipt outputs must be different files")
	}
	return ledgerPath, detailsPath, receiptPath, nil
}

func subjectHashList(subjects map[string]string) []releasegate.SubjectHash {
	names := make([]string, 0, len(subjects))
	for name := range subjects {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]releasegate.SubjectHash, 0, len(names))
	for _, name := range names {
		result = append(result, releasegate.SubjectHash{Name: name, SHA256: subjects[name]})
	}
	return result
}
