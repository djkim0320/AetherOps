//go:build windows

// Command localreleaseevidence runs exactly one fixed local release gate and
// writes its candidate-bound evidence receipt plus sibling audit details. It
// never claims overall release success and never edits the release ledger.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/localreleaseevidence"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps local release evidence:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("localreleaseevidence", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	gateID := flags.String("gate", "", "fixed local gate id")
	ledgerPath := flags.String("ledger", "", "prepared or append-only attached release ledger tip")
	outputPath := flags.String("out", "", "new gate receipt path; receipt and details are never overwritten")
	executablePath := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact packaged candidate executable")
	runtimeManifestPath := flags.String("runtime-manifest", filepath.Join("build", "runtime-manifest.json"), "exact packaged candidate runtime manifest")
	sidecarPath := flags.String("knowledge-sidecar", filepath.Join("build", "knowledge-sidecar", "index.cjs"), "exact packaged candidate sidecar entrypoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(*gateID) == "" || strings.TrimSpace(*ledgerPath) == "" || strings.TrimSpace(*outputPath) == "" {
		return errors.New("-gate, -ledger, and -out are required")
	}
	receipt, err := localreleaseevidence.Generate(ctx, localreleaseevidence.Config{
		GateID: strings.TrimSpace(*gateID), LedgerPath: strings.TrimSpace(*ledgerPath), OutputPath: strings.TrimSpace(*outputPath),
		AetherOpsExecutablePath: strings.TrimSpace(*executablePath), RuntimeManifestPath: strings.TrimSpace(*runtimeManifestPath),
		KnowledgeSidecarEntrypoint: strings.TrimSpace(*sidecarPath),
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "local gate evidence generated: gate=%s status=%s receipt=%s\n", receipt.GateID, receipt.Status, *outputPath)
	return err
}
