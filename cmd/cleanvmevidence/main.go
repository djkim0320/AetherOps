// Command cleanvmevidence captures the release-build host identity reference
// and finalizes a real clean-Windows-VM installer or portable campaign. It
// does not execute fixtures and cannot turn a partial campaign into release
// evidence.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/cleanvmevidence"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps clean VM evidence:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("capture-host or finalize subcommand is required")
	}
	switch strings.ToLower(strings.TrimSpace(args[0])) {
	case "capture-host":
		return captureHost(args[1:])
	case "finalize":
		return finalize(args[1:])
	default:
		return fmt.Errorf("unsupported subcommand %q", args[0])
	}
}

func captureHost(args []string) error {
	flags := flag.NewFlagSet("cleanvmevidence capture-host", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	ledger := flags.String("prepared-ledger", "", "exact current prepared/attached ledger tip")
	source := flags.String("source-root", ".", "exact release source root to seal")
	output := flags.String("out", "", "new host-reference JSON path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || strings.TrimSpace(*ledger) == "" || strings.TrimSpace(*output) == "" {
		return errors.New("capture-host requires -prepared-ledger and -out with no positional arguments")
	}
	reference, err := cleanvmevidence.CaptureHostReference(cleanvmevidence.HostReferenceConfig{
		PreparedLedgerPath: strings.TrimSpace(*ledger), SourceRoot: strings.TrimSpace(*source), OutputPath: strings.TrimSpace(*output),
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "host reference captured: candidate=%s revision=%d source_files=%d out=%s\n",
		reference.ReleaseCandidateID, reference.PreparedLedgerRevision, reference.SourceTreeFiles, *output)
	return err
}

func finalize(args []string) error {
	flags := flag.NewFlagSet("cleanvmevidence finalize", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	ledger := flags.String("prepared-ledger", "", "exact current prepared/attached ledger tip")
	host := flags.String("host-reference", "", "host reference captured before transferring packages to the VM")
	campaign := flags.String("campaign", "", "completed production campaign draft")
	installer := flags.String("installer", "", "exact installer package")
	portable := flags.String("portable", "", "exact portable ZIP")
	manifest := flags.String("package-manifest", "", "exact two-artifact SHA256SUMS.txt")
	dataset := flags.String("dataset", filepath.Join("evals", "research-v1.json"), "exact versioned 12-case quality dataset")
	runner := flags.String("runner-receipt", "", "live product-API runner receipt produced on this VM")
	quality := flags.String("quality-receipt", "", "offline 12/12 quality receipt produced from this VM data")
	output := flags.String("out", "", "new clean_vm evidence receipt; details are emitted beside it")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	for label, value := range map[string]string{
		"-prepared-ledger": *ledger, "-host-reference": *host, "-campaign": *campaign,
		"-installer": *installer, "-portable": *portable, "-package-manifest": *manifest,
		"-dataset": *dataset, "-runner-receipt": *runner, "-quality-receipt": *quality, "-out": *output,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	receipt, err := cleanvmevidence.Finalize(cleanvmevidence.FinalizeConfig{
		PreparedLedgerPath: strings.TrimSpace(*ledger), HostReferencePath: strings.TrimSpace(*host),
		CampaignDraftPath: strings.TrimSpace(*campaign), InstallerPath: strings.TrimSpace(*installer),
		PortablePath: strings.TrimSpace(*portable), PackageManifest: strings.TrimSpace(*manifest),
		DatasetPath: strings.TrimSpace(*dataset), RunnerReceiptPath: strings.TrimSpace(*runner),
		QualityReceiptPath: strings.TrimSpace(*quality), OutputPath: strings.TrimSpace(*output),
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "clean VM evidence generated: gate=%s candidate=%s out=%s\n",
		receipt.GateID, receipt.ReleaseCandidateID, *output)
	return err
}
