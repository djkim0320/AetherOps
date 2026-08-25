// releasegate is the final, source-only admission verifier. It is deliberately
// separate from AetherOps and cannot grant approvals, start model work, or
// synthesize missing external evidence.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/evalgate"
	"github.com/djkim0320/AetherOps/internal/processutil"
	"github.com/djkim0320/AetherOps/internal/releasegate"
	"github.com/djkim0320/AetherOps/internal/securepath"
)

type candidateBinding struct {
	Build           buildinfo.ProductBuildBinding
	Executable      string
	RuntimeManifest string
	Sidecar         string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps release admission:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	flags := flag.NewFlagSet("releasegate", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	mode := flags.String("mode", "verify", "prepare, attach, or verify")
	ledgerPath := flags.String("ledger", "", "release gate ledger path")
	evidencePath := flags.String("evidence", "", "trusted evidence receipt path for attach mode")
	outputPath := flags.String("out", "", "new output JSON path; existing files are never overwritten")
	executablePath := flags.String("aetherops-exe", filepath.Join("build", "aetherops.exe"), "exact candidate executable")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if strings.TrimSpace(*outputPath) == "" {
		return errors.New("-out is required and must name a new JSON file")
	}
	candidate, err := bindCandidate(strings.TrimSpace(*executablePath))
	if err != nil {
		return err
	}
	if err := requireReleaseCandidateDiagnostic(candidate.Executable); err != nil {
		return err
	}
	switch strings.ToLower(strings.TrimSpace(*mode)) {
	case "prepare":
		ledger, err := releasegate.PrepareLedger(candidate.Build, time.Now().UTC())
		if err != nil {
			return err
		}
		if err := reauthenticateCandidate(candidate); err != nil {
			return err
		}
		return evalgate.WriteJSONNew(strings.TrimSpace(*outputPath), ledger)
	case "attach":
		if strings.TrimSpace(*ledgerPath) == "" || strings.TrimSpace(*evidencePath) == "" {
			return errors.New("-ledger and -evidence are required in attach mode")
		}
		next, err := releasegate.AttachEvidence(
			strings.TrimSpace(*ledgerPath), strings.TrimSpace(*evidencePath), strings.TrimSpace(*outputPath),
			candidate.Build, time.Now().UTC(),
		)
		if err != nil {
			return err
		}
		if err := reauthenticateCandidate(candidate); err != nil {
			return err
		}
		return evalgate.WriteJSONNew(strings.TrimSpace(*outputPath), next)
	case "verify":
		if strings.TrimSpace(*ledgerPath) == "" {
			return errors.New("-ledger is required in verify mode")
		}
		receipt, err := releasegate.Verify(strings.TrimSpace(*ledgerPath), candidate.Build, time.Now().UTC())
		if err != nil {
			return err
		}
		if err := reauthenticateCandidate(candidate); err != nil {
			return err
		}
		if err := evalgate.WriteJSONNew(strings.TrimSpace(*outputPath), receipt); err != nil {
			return err
		}
		if !receipt.Passed {
			return fmt.Errorf("release admission blocked: %d/%d gates passed; failure receipt was written", receipt.PassedGates, receipt.RequiredGates)
		}
		return nil
	default:
		return fmt.Errorf("unsupported mode %q", *mode)
	}
}

type releaseCandidateDiagnostic struct {
	Schema          string `json:"schema"`
	Configured      bool   `json:"configured"`
	KeyID           string `json:"key_id"`
	FeedURLSHA256   string `json:"feed_url_sha256"`
	PublicKeySHA256 string `json:"public_key_sha256"`
	BuildMode       string `json:"build_mode"`
}

func requireReleaseCandidateDiagnostic(executable string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "runtime-trust-diagnostic")
	processutil.ConfigureNoWindow(command)
	command.Env = releaseDiagnosticEnvironment(os.Environ())
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return fmt.Errorf("authenticate release build mode and embedded trust: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if stdout.Len() > 64*1024 || stderr.Len() > 64*1024 {
		return errors.New("release candidate diagnostic exceeded its output limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	decoder.DisallowUnknownFields()
	var diagnostic releaseCandidateDiagnostic
	if err := decoder.Decode(&diagnostic); err != nil {
		return fmt.Errorf("decode release candidate diagnostic: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("release candidate diagnostic contains trailing JSON")
	}
	return validateReleaseCandidateDiagnostic(diagnostic)
}

func validateReleaseCandidateDiagnostic(diagnostic releaseCandidateDiagnostic) error {
	if diagnostic.Schema != "aetherops_runtime_update_trust_v2" || diagnostic.BuildMode != "release" ||
		!diagnostic.Configured || diagnostic.KeyID == "" {
		return errors.New("release ledger requires a release-mode candidate with configured embedded runtime trust")
	}
	for _, digest := range []string{diagnostic.FeedURLSHA256, diagnostic.PublicKeySHA256} {
		decoded, err := hex.DecodeString(digest)
		if err != nil || len(decoded) != 32 || digest != strings.ToLower(digest) {
			return errors.New("release candidate diagnostic contains an invalid trust digest")
		}
	}
	return nil
}

func releaseDiagnosticEnvironment(environment []string) []string {
	blocked := map[string]struct{}{
		"AETHEROPS_DEV": {}, "AETHEROPS_DATA_DIR": {}, "AETHEROPS_RUNTIME_FEED_URL": {},
		"AETHEROPS_RUNTIME_KEY_ID": {}, "AETHEROPS_RUNTIME_PUBLIC_KEY_BASE64": {},
		"NODE_OPTIONS": {}, "NODE_PATH": {}, "HTTP_PROXY": {}, "HTTPS_PROXY": {}, "ALL_PROXY": {}, "NO_PROXY": {},
	}
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if _, reject := blocked[strings.ToUpper(name)]; !reject {
			result = append(result, entry)
		}
	}
	return result
}

func bindCandidate(executablePath string) (candidateBinding, error) {
	if executablePath == "" {
		return candidateBinding{}, errors.New("-aetherops-exe is required")
	}
	executable, err := securepath.RegularPath(executablePath)
	if err != nil {
		return candidateBinding{}, fmt.Errorf("authenticate candidate executable: %w", err)
	}
	if !strings.EqualFold(filepath.Base(executable), "aetherops.exe") {
		return candidateBinding{}, errors.New("candidate executable must be named aetherops.exe")
	}
	directory := filepath.Dir(executable)
	manifest, err := securepath.RegularPathWithin(directory, "runtime-manifest.json")
	if err != nil {
		return candidateBinding{}, fmt.Errorf("authenticate sibling runtime manifest: %w", err)
	}
	sidecar, err := securepath.RegularPathWithin(directory, filepath.Join("knowledge-sidecar", "index.cjs"))
	if err != nil {
		return candidateBinding{}, fmt.Errorf("authenticate sibling knowledge sidecar: %w", err)
	}
	build, err := buildinfo.BindProductBuild(executable, manifest, sidecar)
	if err != nil {
		return candidateBinding{}, err
	}
	return candidateBinding{Build: build, Executable: executable, RuntimeManifest: manifest, Sidecar: sidecar}, nil
}

func reauthenticateCandidate(expected candidateBinding) error {
	actual, err := bindCandidate(expected.Executable)
	if err != nil {
		return fmt.Errorf("re-authenticate release candidate: %w", err)
	}
	if actual != expected {
		return errors.New("release candidate changed during the gate operation")
	}
	return nil
}
