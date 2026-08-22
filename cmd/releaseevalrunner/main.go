package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/djkim0320/Aether-claw/internal/evalgate"
	"github.com/djkim0320/Aether-claw/internal/evalrunner"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps release evaluation runner:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("releaseevalrunner", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	mode := flags.String("mode", "start", "start or resume")
	datasetPath := flags.String("dataset", filepath.Join("evals", "research-v1.json"), "exact versioned evaluation dataset")
	endpoint := flags.String("endpoint", "", "AetherOps IPv4 loopback API origin")
	tokenFile := flags.String("token-file", "", "file containing the AetherOps bearer token; token values are never accepted on argv")
	descriptorPath := flags.String("descriptor", "", "descriptor emitted by aetherops.exe release-eval-session")
	projectID := flags.String("project-id", "", "existing target project id")
	sessionID := flags.String("session-id", "", "existing target conversation session id")
	journalPath := flags.String("journal", "", "new journal path in start mode, or existing journal path in resume mode")
	outputPath := flags.String("out", "", "new final run-set receipt path; existing files are never overwritten")
	executablePath := flags.String("aetherops-exe", "", "exact packaged aetherops.exe used for evaluation")
	runtimeManifestPath := flags.String("runtime-manifest", "", "exact runtime-manifest.json packaged beside aetherops.exe")
	knowledgeSidecarPath := flags.String("knowledge-sidecar", "", "exact packaged knowledge-sidecar/index.cjs")
	pollInterval := flags.Duration("poll-interval", 2*time.Second, "read-only run status polling interval")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	for label, value := range map[string]string{
		"-journal": *journalPath,
		"-out":     *outputPath, "-aetherops-exe": *executablePath,
		"-runtime-manifest": *runtimeManifestPath, "-knowledge-sidecar": *knowledgeSidecarPath,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", label)
		}
	}
	if err := validatePackagedLayout(*executablePath, *runtimeManifestPath, *knowledgeSidecarPath); err != nil {
		return err
	}
	dataset, err := evalgate.LoadDataset(strings.TrimSpace(*datasetPath))
	if err != nil {
		return err
	}
	build, err := evalgate.BindProductBuild(
		strings.TrimSpace(*executablePath), strings.TrimSpace(*runtimeManifestPath), strings.TrimSpace(*knowledgeSidecarPath),
	)
	if err != nil {
		return err
	}
	var token []byte
	if strings.TrimSpace(*descriptorPath) != "" {
		if strings.TrimSpace(*endpoint) != "" || strings.TrimSpace(*tokenFile) != "" {
			return errors.New("-descriptor cannot be combined with -endpoint or -token-file")
		}
		descriptor, descriptorToken, descriptorErr := evalrunner.LoadSessionDescriptor(strings.TrimSpace(*descriptorPath), build)
		if descriptorErr != nil {
			return descriptorErr
		}
		*endpoint = descriptor.Endpoint
		token = descriptorToken
	} else {
		if strings.TrimSpace(*endpoint) == "" || strings.TrimSpace(*tokenFile) == "" {
			return errors.New("provide -descriptor, or both -endpoint and -token-file")
		}
		token, err = evalrunner.ReadTokenFile(strings.TrimSpace(*tokenFile))
		if err != nil {
			return err
		}
	}
	defer evalrunner.ZeroToken(token)
	config := evalrunner.Config{
		Dataset: dataset, ProductBuild: build, Endpoint: strings.TrimSpace(*endpoint), Token: token,
		Target:      evalrunner.Target{ProjectID: strings.TrimSpace(*projectID), SessionID: strings.TrimSpace(*sessionID)},
		JournalPath: strings.TrimSpace(*journalPath), OutputPath: strings.TrimSpace(*outputPath),
		PollInterval: *pollInterval, EvidenceClass: evalrunner.EvidenceLiveProductAPI,
	}
	switch strings.ToLower(strings.TrimSpace(*mode)) {
	case "start":
		_, err = evalrunner.Start(ctx, config)
	case "resume":
		_, err = evalrunner.Resume(ctx, config)
	default:
		return fmt.Errorf("unsupported mode %q", *mode)
	}
	return err
}

func validatePackagedLayout(executablePath, runtimeManifestPath, sidecarPath string) error {
	executable, err := filepath.Abs(strings.TrimSpace(executablePath))
	if err != nil {
		return err
	}
	manifest, err := filepath.Abs(strings.TrimSpace(runtimeManifestPath))
	if err != nil {
		return err
	}
	sidecar, err := filepath.Abs(strings.TrimSpace(sidecarPath))
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	if !strings.EqualFold(filepath.Base(executable), "aetherops.exe") ||
		!strings.EqualFold(filepath.Clean(manifest), filepath.Join(root, "runtime-manifest.json")) ||
		!strings.EqualFold(filepath.Clean(sidecar), filepath.Join(root, "knowledge-sidecar", "index.cjs")) {
		return errors.New("release evaluation inputs must be the executable, runtime manifest, and sidecar from one packaged AetherOps root")
	}
	return nil
}
