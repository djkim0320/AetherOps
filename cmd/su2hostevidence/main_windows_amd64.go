//go:build windows && amd64

// Command su2hostevidence emits trusted release evidence only when this real
// Windows x64 host is natively incompatible with the packaged SU2 runtime.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/djkim0320/AetherOps/internal/su2hostevidence"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps SU2 host evidence:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("su2hostevidence", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	ledgerPath := flags.String("ledger", "", "current prepared release ledger tip")
	outputPath := flags.String("out", "", "new incompatible-host evidence receipt path")
	executablePath := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact packaged candidate executable")
	runtimeManifestPath := flags.String("runtime-manifest", filepath.Join("build", "runtime-manifest.json"), "exact packaged candidate runtime manifest")
	sidecarPath := flags.String("knowledge-sidecar", filepath.Join("build", "knowledge-sidecar", "index.cjs"), "exact packaged candidate sidecar entrypoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(*ledgerPath) == "" || strings.TrimSpace(*outputPath) == "" {
		return errors.New("-ledger and -out are required")
	}
	receipt, err := su2hostevidence.Generate(ctx, su2hostevidence.Config{
		LedgerPath: *ledgerPath, OutputPath: *outputPath, AetherOpsExecutablePath: *executablePath,
		RuntimeManifestPath: *runtimeManifestPath, KnowledgeSidecarEntrypoint: *sidecarPath,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "incompatible SU2 host evidence generated: status=%s receipt=%s\n", receipt.Status, *outputPath)
	return err
}
