//go:build windows && amd64

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/djkim0320/Aether-claw/internal/liveauthevidence"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps live auth evidence:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("liveauthevidence", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	ledgerPath := flags.String("ledger", "", "current prepared release ledger tip")
	outputPath := flags.String("out", "", "new live-auth evidence receipt path")
	descriptorPath := flags.String("descriptor", "", "protected descriptor emitted by aetherops.exe release-eval-session")
	executablePath := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact packaged AetherOps executable")
	manifestPath := flags.String("runtime-manifest", filepath.Join("build", "runtime-manifest.json"), "exact packaged runtime manifest")
	sidecarPath := flags.String("knowledge-sidecar", filepath.Join("build", "knowledge-sidecar", "index.cjs"), "exact packaged sidecar entrypoint")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(*ledgerPath) == "" || strings.TrimSpace(*outputPath) == "" || strings.TrimSpace(*descriptorPath) == "" {
		return errors.New("-ledger, -out, and -descriptor are required")
	}
	receipt, err := liveauthevidence.Generate(ctx, liveauthevidence.Config{
		LedgerPath: *ledgerPath, OutputPath: *outputPath, SessionDescriptorPath: *descriptorPath,
		AetherOpsExecutablePath: *executablePath, RuntimeManifestPath: *manifestPath,
		KnowledgeSidecarEntrypoint: *sidecarPath,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "live auth exact-model evidence generated: status=%s receipt=%s\n", receipt.Status, *outputPath)
	return err
}
