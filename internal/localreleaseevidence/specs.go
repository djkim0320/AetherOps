package localreleaseevidence

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type gatePlan struct {
	Commands         []commandSpec
	TemporaryRoot    string
	GateArtifactPath string
}

func fixedGatePlan(gateID, sourceRoot, goExecutable, powerShellExecutable, candidateExecutable, temporaryRoot string) (gatePlan, error) {
	goVersion := commandSpec{
		ID: "go_version", Executable: goExecutable, Arguments: []string{"version"}, Timeout: 30 * time.Second,
	}
	switch gateID {
	case GateLocalSourceTests:
		nodeRoot := filepath.Join(sourceRoot, ".runtime", "versions", "node", "24.19.0")
		nodeExecutable := filepath.Join(nodeRoot, "node.exe")
		npmCLI := filepath.Join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
		return gatePlan{Commands: []commandSpec{
			goVersion,
			{ID: "node_version", Executable: nodeExecutable, Arguments: []string{"--version"}, Timeout: 30 * time.Second},
			{ID: "npm_version", Executable: nodeExecutable, Arguments: []string{npmCLI, "--version"}, Timeout: 30 * time.Second},
			{
				ID: "local_source_tests", Executable: powerShellExecutable,
				Arguments: []string{
					"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
					"-File", filepath.Join(sourceRoot, "tools", "dev.ps1"), "test",
				},
				Environment: []EnvironmentVariable{{Name: "PATH_PREPEND", Value: nodeRoot}},
				Timeout:     30 * time.Minute,
			},
		}}, nil
	case GateWindowsHost:
		if strings.TrimSpace(temporaryRoot) == "" {
			return gatePlan{}, errors.New("Gate 0 requires an isolated temporary data root")
		}
		return gatePlan{TemporaryRoot: temporaryRoot, Commands: []commandSpec{{
			ID: "packaged_gate0", Executable: candidateExecutable, Arguments: []string{"gate0", "--data-root", temporaryRoot},
			Timeout: 2 * time.Minute,
		}}}, nil
	case GateRAG50000:
		if strings.TrimSpace(temporaryRoot) == "" {
			return gatePlan{}, errors.New("50k retrieval gate requires a temporary artifact root")
		}
		artifact := filepath.Join(temporaryRoot, "hybrid-graph-v1-50k-performance-v1.json")
		return gatePlan{TemporaryRoot: temporaryRoot, GateArtifactPath: artifact, Commands: []commandSpec{
			goVersion,
			{
				ID: "rag_50000", Executable: goExecutable,
				Arguments: []string{"test", "./internal/store", "-run", "^TestHybridGraphV1FiftyThousandChunkReleaseGate$", "-count=1", "-v", "-timeout=20m"},
				Environment: []EnvironmentVariable{
					{Name: "AETHEROPS_RUN_50K_RETRIEVAL_GATE", Value: "1"},
					{Name: "AETHEROPS_RETRIEVAL_RECEIPT", Value: artifact},
				},
				Timeout: 25 * time.Minute,
			},
		}}, nil
	case GateScheduler:
		contractPattern := "^(" + strings.Join(schedulerContractTests, "|") + ")$"
		return gatePlan{Commands: []commandSpec{
			goVersion,
			{
				ID: "scheduler_contracts", Executable: goExecutable,
				Arguments: []string{"test", "./internal/schedule", "-run", contractPattern, "-count=1", "-v", "-timeout=5m"},
				Timeout:   6 * time.Minute,
			},
			{
				ID: "scheduler_forced_exit", Executable: goExecutable,
				Arguments: []string{"test", "./internal/schedule", "-run", "^TestServiceForcedTerminationBoundariesNeverDuplicateOccurrence$", "-count=1", "-v", "-timeout=5m"},
				Timeout:   6 * time.Minute,
			},
		}}, nil
	default:
		return gatePlan{}, errors.New("gate is not one of the four fixed local release gates")
	}
}

func commandPassed(observation CommandObservation) bool {
	return observation.StartError == "" && observation.ExitCode == 0
}

func outputProvesTestRan(observation CommandObservation, testName string) bool {
	if !commandPassed(observation) || observation.Stdout.Truncated {
		return false
	}
	quoted := regexp.QuoteMeta(testName)
	passed := regexp.MustCompile(`(?m)^--- PASS: ` + quoted + `(?:/[^ ]+)? \(`).MatchString(observation.Stdout.Text)
	skipped := regexp.MustCompile(`(?m)^--- SKIP: ` + quoted + `(?:/[^ ]+)? \(`).MatchString(observation.Stdout.Text)
	return passed && !skipped
}

func prependPath(value, existing string) string {
	if strings.TrimSpace(existing) == "" {
		return value
	}
	return value + string(os.PathListSeparator) + existing
}
