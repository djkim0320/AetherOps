//go:build windows

// liveembeddingsevidence is an isolated producer for the real
// live_embeddings_shadow gate. It is deliberately not registered in the
// global release policy until root coordination reviews its complete contract.
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
	"strings"
	"syscall"

	"github.com/djkim0320/Aether-claw/internal/desktop"
	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/liveembeddingsevidence"
	"github.com/djkim0320/Aether-claw/internal/securepath"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps live embeddings evidence:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) (returnErr error) {
	flags := flag.NewFlagSet("liveembeddingsevidence", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	mode := flags.String("mode", "live", "live or offline-finalize")
	preparedLedger := flags.String("prepared-ledger", "", "exact current prepared release ledger")
	executable := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact packaged candidate aetherops.exe")
	dataset := flags.String("dataset", filepath.Join("evals", "research-v1.json"), "exact 12-case release dataset")
	runnerReceipt := flags.String("runner-receipt", "", "completed real live releaseevalrunner receipt")
	sessionDescriptor := flags.String("session-descriptor", "", "protected running candidate release-eval session descriptor; live only")
	query := flags.String("query", "", "exact live memory search query; live only and never stored in the journal")
	journal := flags.String("journal", "", "new live JSONL journal or existing completed journal")
	dataRoot := flags.String("data-root", "", "AetherOps v2 data root; offline-finalize defaults to LOCALAPPDATA")
	detailsOut := flags.String("details-out", "", "new direct ledger-sibling .details.json; offline-finalize only")
	receiptOut := flags.String("receipt-out", "", "new direct ledger-sibling .receipt.json; offline-finalize only")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	for _, required := range []struct{ name, value string }{
		{"-prepared-ledger", *preparedLedger}, {"-runner-receipt", *runnerReceipt}, {"-journal", *journal},
	} {
		if strings.TrimSpace(required.value) == "" {
			return fmt.Errorf("%s is required", required.name)
		}
	}
	ledgerPath, journalPath, err := authenticateLedgerJournal(*preparedLedger, *journal, strings.EqualFold(*mode, "live"))
	if err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(*mode)) {
	case "live":
		if strings.TrimSpace(*sessionDescriptor) == "" || strings.TrimSpace(*query) == "" {
			return errors.New("-session-descriptor and -query are required in live mode")
		}
		if strings.TrimSpace(*detailsOut) != "" || strings.TrimSpace(*receiptOut) != "" || strings.TrimSpace(*dataRoot) != "" {
			return errors.New("live mode writes only the journal; offline output flags are not accepted")
		}
		_, err := liveembeddingsevidence.ObserveLive(ctx, liveembeddingsevidence.LiveConfig{
			CandidateExecutable: *executable, PreparedLedger: ledgerPath, DatasetPath: *dataset,
			RunnerReceipt: *runnerReceipt, SessionDescriptor: *sessionDescriptor, Query: *query, JournalPath: journalPath,
		})
		return err
	case "offline-finalize":
		if strings.TrimSpace(*sessionDescriptor) != "" || strings.TrimSpace(*query) != "" {
			return errors.New("offline-finalize never accepts a session token descriptor or raw query")
		}
		detailsPath, receiptPath, err := authenticateOutputs(ledgerPath, *detailsOut, *receiptOut)
		if err != nil {
			return err
		}
		root, err := resolveDataRoot(*dataRoot)
		if err != nil {
			return err
		}
		lease, primary, err := desktop.AcquireInstanceLease("AetherOps.v2")
		if err != nil {
			return fmt.Errorf("acquire offline verification lease: %w", err)
		}
		if !primary {
			return errors.New("AetherOps is running; close it before immutable SQLite/CAS finalization")
		}
		defer func() { returnErr = errors.Join(returnErr, lease.Close()) }()
		config := liveembeddingsevidence.FinalizeConfig{
			CandidateExecutable: *executable, PreparedLedger: ledgerPath, DatasetPath: *dataset,
			RunnerReceipt: *runnerReceipt, JournalPath: journalPath, DataRoot: root,
		}
		result, err := liveembeddingsevidence.FinalizeOffline(ctx, config)
		if err != nil {
			return err
		}
		detailsRaw, err := json.MarshalIndent(result.Details, "", "  ")
		if err != nil {
			return err
		}
		detailsRaw = append(detailsRaw, '\n')
		detailsDigest := sha256.Sum256(detailsRaw)
		detailsSHA := hex.EncodeToString(detailsDigest[:])
		build, err := liveembeddingsevidence.AuthenticateCandidate(*executable)
		if err != nil {
			return err
		}
		receipt, err := liveembeddingsevidence.BuildIsolatedReceipt(result, build, detailsPath, detailsSHA)
		if err != nil {
			return err
		}
		if err := evalgate.WriteJSONNew(detailsPath, result.Details); err != nil {
			return err
		}
		published, err := securepath.ReadRegular(detailsPath, 4<<20)
		if err != nil || !bytes.Equal(published, detailsRaw) {
			return errors.New("published details failed exact readback")
		}
		if err := liveembeddingsevidence.ReauthenticateFinalized(config, result, build); err != nil {
			return fmt.Errorf("reauthenticate immediately before receipt publication: %w", err)
		}
		if err := evalgate.WriteJSONNew(receiptPath, receipt); err != nil {
			return err
		}
		return nil
	default:
		return errors.New("-mode must be live or offline-finalize")
	}
}

func authenticateLedgerJournal(ledger, journal string, journalMustBeNew bool) (string, string, error) {
	ledgerPath, err := securepath.RegularPath(strings.TrimSpace(ledger))
	if err != nil {
		return "", "", err
	}
	journalPath, err := filepath.Abs(strings.TrimSpace(journal))
	if err != nil {
		return "", "", err
	}
	name, err := securepath.SiblingName(filepath.Base(journalPath))
	if err != nil || !strings.EqualFold(filepath.Dir(journalPath), filepath.Dir(ledgerPath)) || !strings.HasSuffix(strings.ToLower(name), ".journal.jsonl") {
		return "", "", errors.New("journal must be a direct prepared-ledger sibling ending in .journal.jsonl")
	}
	if journalMustBeNew {
		if _, err := os.Lstat(journalPath); err == nil {
			return "", "", errors.New("live journal already exists; ambiguous or completed POSTs are never resumed or retried")
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", "", err
		}
	} else if _, err := securepath.RegularPath(journalPath); err != nil {
		return "", "", err
	}
	return ledgerPath, journalPath, nil
}

func authenticateOutputs(ledger, details, receipt string) (string, string, error) {
	root := filepath.Dir(ledger)
	resolve := func(raw, suffix string) (string, error) {
		absolute, err := filepath.Abs(strings.TrimSpace(raw))
		if err != nil {
			return "", err
		}
		name, err := securepath.SiblingName(filepath.Base(absolute))
		if err != nil || !strings.EqualFold(filepath.Dir(absolute), root) || !strings.HasSuffix(strings.ToLower(name), suffix) {
			return "", errors.New("output must be a new direct ledger sibling with the required suffix")
		}
		if _, err := os.Lstat(absolute); err == nil {
			return "", errors.New("output already exists")
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		return absolute, nil
	}
	detailsPath, err := resolve(details, ".details.json")
	if err != nil {
		return "", "", err
	}
	receiptPath, err := resolve(receipt, ".receipt.json")
	if err != nil {
		return "", "", err
	}
	if strings.EqualFold(detailsPath, receiptPath) {
		return "", "", errors.New("details and receipt outputs must differ")
	}
	return detailsPath, receiptPath, nil
}

func resolveDataRoot(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		local := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if local == "" {
			return "", errors.New("LOCALAPPDATA is unavailable; specify -data-root")
		}
		value = filepath.Join(local, "AetherOps", "v2")
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("data root must be an existing regular directory")
	}
	return absolute, nil
}
