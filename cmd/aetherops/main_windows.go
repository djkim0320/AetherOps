//go:build windows && amd64

package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/djkim0320/Aether-claw/internal/api"
	"github.com/djkim0320/Aether-claw/internal/appdata"
	"github.com/djkim0320/Aether-claw/internal/approval"
	"github.com/djkim0320/Aether-claw/internal/browser"
	"github.com/djkim0320/Aether-claw/internal/buildinfo"
	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/codex"
	"github.com/djkim0320/Aether-claw/internal/desktop"
	"github.com/djkim0320/Aether-claw/internal/dispatch"
	"github.com/djkim0320/Aether-claw/internal/download"
	"github.com/djkim0320/Aether-claw/internal/engineering"
	"github.com/djkim0320/Aether-claw/internal/gate0windows"
	"github.com/djkim0320/Aether-claw/internal/integration"
	"github.com/djkim0320/Aether-claw/internal/knowledge"
	"github.com/djkim0320/Aether-claw/internal/mcpserver"
	memoryindex "github.com/djkim0320/Aether-claw/internal/memory"
	"github.com/djkim0320/Aether-claw/internal/processutil"
	"github.com/djkim0320/Aether-claw/internal/rag"
	"github.com/djkim0320/Aether-claw/internal/research"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/schedule"
	"github.com/djkim0320/Aether-claw/internal/secret"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/djkim0320/Aether-claw/internal/toolstudio"
	"github.com/djkim0320/Aether-claw/internal/ui"
)

const (
	version       = buildinfo.ReleaseProductVersion
	applicationID = "AetherOps.v2"
)

// Private release packaging injects these values with -ldflags. Shipping
// behavior never accepts environment overrides for build identity or trust.
var (
	runtimeUpdateFeedURL         string
	runtimeUpdateKeyID           string
	runtimeUpdatePublicKeyBase64 string
	buildMode                    = "development"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "AetherOps:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	command := "app"
	if len(args) > 0 {
		command = strings.ToLower(strings.TrimSpace(args[0]))
	}
	switch command {
	case "app":
		return runApplication(ctx)
	case "release-eval-session":
		options, err := parseReleaseEvalSessionArgs(args[1:])
		if err != nil {
			return err
		}
		return runApplicationWithReleaseDescriptor(ctx, options.DescriptorPath, options.DataRoot)
	case "mcp":
		dataRoot, err := parseOptionalDataRootArgs("mcp", args[1:])
		if err != nil {
			return err
		}
		return runInternalMCP(ctx, dataRoot)
	case "engineering-mcp":
		dataRoot, err := parseOptionalDataRootArgs("engineering-mcp", args[1:])
		if err != nil {
			return err
		}
		return runEngineeringMCP(ctx, dataRoot)
	case "chrome-mcp":
		return runChromeMCP(ctx, args[1:])
	case "gate0":
		dataRoot, err := parseGate0Args(args[1:])
		if err != nil {
			return err
		}
		return runGate0(ctx, dataRoot)
	case "runtime-trust-diagnostic":
		return writeEmbeddedRuntimeTrustDiagnostic(os.Stdout)
	case "su2-host-preflight":
		return writeSU2HostPreflight(os.Stdout)
	case "version", "--version", "-v":
		_, err := fmt.Fprintln(os.Stdout, "AetherOps", version)
		return err
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func writeSU2HostPreflight(output io.Writer) error {
	if output == nil {
		return errors.New("SU2 host preflight output is unavailable")
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve AetherOps executable: %w", err)
	}
	receipt, err := engineering.NativeSU2HostPreflight(executable, time.Now().UTC())
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(receipt)
}

const runtimeTrustDiagnosticSchema = "aetherops_runtime_update_trust_v2"

type runtimeTrustDiagnostic struct {
	Schema          string `json:"schema"`
	Configured      bool   `json:"configured"`
	KeyID           string `json:"key_id,omitempty"`
	FeedURLSHA256   string `json:"feed_url_sha256,omitempty"`
	PublicKeySHA256 string `json:"public_key_sha256,omitempty"`
	BuildMode       string `json:"build_mode"`
}

// embeddedRuntimeTrustDiagnostic deliberately reads linker-populated values
// only. Development environment overrides must never make an untrusted/stale
// release executable appear correctly configured to the packager.
func embeddedRuntimeTrustDiagnostic() (runtimeTrustDiagnostic, error) {
	diagnostic := runtimeTrustDiagnostic{Schema: runtimeTrustDiagnosticSchema, BuildMode: normalizedBuildMode()}
	feedURL := runtimeUpdateFeedURL
	keyID := runtimeUpdateKeyID
	publicKey := runtimeUpdatePublicKeyBase64
	configured := 0
	for _, value := range []string{feedURL, keyID, publicKey} {
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		return diagnostic, nil
	}
	if configured != 3 {
		return diagnostic, errors.New("embedded runtime update trust is incomplete")
	}
	for _, value := range []string{feedURL, keyID, publicKey} {
		if value != strings.TrimSpace(value) {
			return diagnostic, errors.New("embedded runtime update trust contains leading or trailing whitespace")
		}
	}
	parsed, err := url.Parse(feedURL)
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return diagnostic, errors.New("embedded runtime update feed is not a safe HTTPS URL")
	}
	if _, err := managedruntime.ParseTrustRoot(keyID, publicKey); err != nil {
		return diagnostic, fmt.Errorf("validate embedded runtime update trust root: %w", err)
	}
	decodedKey, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil || len(decodedKey) != 32 {
		return diagnostic, errors.New("embedded runtime update public key is invalid")
	}
	feedDigest := sha256.Sum256([]byte(feedURL))
	keyDigest := sha256.Sum256(decodedKey)
	diagnostic.Configured = true
	diagnostic.KeyID = keyID
	diagnostic.FeedURLSHA256 = hex.EncodeToString(feedDigest[:])
	diagnostic.PublicKeySHA256 = hex.EncodeToString(keyDigest[:])
	return diagnostic, nil
}

func normalizedBuildMode() string {
	if strings.EqualFold(strings.TrimSpace(buildMode), "release") {
		return "release"
	}
	return "development"
}

func writeEmbeddedRuntimeTrustDiagnostic(output io.Writer) error {
	if output == nil {
		return errors.New("runtime trust diagnostic output is unavailable")
	}
	diagnostic, err := embeddedRuntimeTrustDiagnostic()
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(diagnostic)
}

func runApplication(ctx context.Context) error {
	return runApplicationWithReleaseDescriptor(ctx, "", "")
}

func runApplicationWithReleaseDescriptor(ctx context.Context, releaseDescriptorPath, isolatedDataRoot string) (returnErr error) {
	instanceLease, primary, err := desktop.AcquireInstanceLease(applicationID)
	if err != nil {
		return fmt.Errorf("acquire AetherOps instance lease: %w", err)
	}
	if !primary {
		return handleSecondaryApplicationInstance(ctx, releaseDescriptorPath)
	}
	defer func() { returnErr = errors.Join(returnErr, instanceLease.Close()) }()
	paths, db, objects, err := openStorageAt(ctx, isolatedDataRoot)
	if err != nil {
		return err
	}
	defer db.Close()
	blobRegistry, err := db.ReconcileBlobRegistry(ctx)
	if err != nil {
		return fmt.Errorf("reconcile authoritative CAS registry: %w", err)
	}
	if _, err := objects.Reconcile(ctx, blobRegistry.Reachable); err != nil {
		return fmt.Errorf("reconcile interrupted CAS cleanup: %w", err)
	}
	if _, err := appdata.ApplyPendingInternetProfileReset(paths); err != nil {
		return fmt.Errorf("apply pending internet browser profile reset: %w", err)
	}
	if _, err := db.RecoverInFlight(ctx); err != nil {
		return fmt.Errorf("recover interrupted work: %w", err)
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	proxy, err := browser.StartEgressProxy(browser.Policy{}, logger)
	if err != nil {
		return fmt.Errorf("start guarded browser egress: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, proxy.Close(shutdownCtx))
	}()

	host, err := desktop.NewHost(desktop.Config{
		ApplicationID:       applicationID,
		WindowTitle:         "AetherOps",
		ShellUserDataDir:    paths.ShellProfile,
		InternetUserDataDir: paths.InternetProfile,
		InternetProxyURL:    "http://" + proxy.Address(),
		DownloadDir:         paths.Downloads,
		InitialSurface:      desktop.SurfaceShell,
	})
	if err != nil {
		return err
	}
	hostResult := make(chan error, 1)
	go func() { hostResult <- host.Run(ctx) }()
	readyCtx, cancelReady := context.WithTimeout(ctx, 30*time.Second)
	err = host.WaitReady(readyCtx)
	cancelReady()
	if err != nil {
		return fmt.Errorf("start isolated WebView2 host: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, host.Close(shutdownCtx))
	}()
	gateCtx, cancelGate := context.WithTimeout(ctx, 10*time.Second)
	gate, err := host.Gate0(gateCtx)
	cancelGate()
	if err != nil || !gate.Compliant {
		return fmt.Errorf("WebView2 Gate 0 failed: %w", err)
	}
	runtimeSupervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return fmt.Errorf("create runtime Job Object: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, runtimeSupervisor.Close()) }()
	updater, err := newRuntimeUpdater(paths, db,
		fmt.Sprintf("http://127.0.0.1:%d", gate.Internet.CDPPort), runtimeSupervisor.Assign)
	if err != nil {
		return fmt.Errorf("initialize managed runtime updater: %w", err)
	}
	if err := updater.ActivateOnStartup(ctx); err != nil {
		return fmt.Errorf("reconcile managed runtime activation: %w", err)
	}

	runtimePaths, err := resolveManagedRuntime(paths)
	if err != nil {
		if !setupModeAllowed(releaseDescriptorPath) {
			return fmt.Errorf("release evaluation session requires the complete managed runtime: %w", err)
		}
		logger.Warn("managed runtime is unavailable; opening setup mode", "error", err)
		return runSetupApplication(ctx, paths, db, objects, host, hostResult, updater)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	runtimeManifestPath, err := findRuntimeManifest()
	if err != nil {
		return fmt.Errorf("locate runtime manifest for build provenance: %w", err)
	}
	knowledgeSidecarEntrypoint, err := findKnowledgeSidecarEntrypoint()
	if err != nil {
		return fmt.Errorf("locate knowledge sidecar for build provenance: %w", err)
	}
	productBuild, err := buildinfo.BindProductBuild(executable, runtimeManifestPath, knowledgeSidecarEntrypoint)
	if err != nil {
		return fmt.Errorf("bind product build provenance: %w", err)
	}
	if err := db.SetProductBuildBinding(productBuild); err != nil {
		return fmt.Errorf("configure product build provenance: %w", err)
	}
	evaluationDataRoot := ""
	if releaseDescriptorPath != "" {
		evaluationDataRoot = paths.Root
	}
	toolService := &toolstudio.Service{DB: db}
	if err := integration.WriteCodexMCPConfig(integration.CodexMCPConfig{
		CodexHome:           paths.CodexHome,
		AetherOpsExecutable: executable,
		InternetCDPEndpoint: fmt.Sprintf("http://127.0.0.1:%d", gate.Internet.CDPPort),
		EvaluationDataRoot:  evaluationDataRoot,
	}); err != nil {
		return fmt.Errorf("write isolated Codex configuration: %w", err)
	}
	knowledgeSidecar, err := startKnowledgeSidecar(ctx, runtimePaths, knowledgeSidecarEntrypoint, runtimeSupervisor.Assign)
	if err != nil {
		return fmt.Errorf("start required Oxigraph knowledge sidecar: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, knowledgeSidecar.Close()) }()
	knowledgeService := &knowledge.Service{DB: db, CAS: objects, Sidecar: knowledgeSidecar}
	curationRecovered, curationRecoveryErr := knowledgeService.RecoverCurationValidationCandidates(ctx)
	if curationRecoveryErr != nil {
		return fmt.Errorf("recover disposable knowledge edit validation candidates: %w", curationRecoveryErr)
	}
	if curationRecovered != 0 {
		logger.Info("removed interrupted knowledge edit validation candidates", "candidates", curationRecovered)
	}
	schemaRecovery, schemaRecoveryErr := knowledgeService.RecoverSchemaOnlyHeads(ctx)
	if schemaRecoveryErr != nil {
		logger.Warn("schema-only knowledge snapshot recovery remains fail-closed",
			"projects", schemaRecovery.Projects, "materialized", schemaRecovery.Materialized,
			"failed", schemaRecovery.Failed, "failures", schemaRecovery.Failures)
	} else if schemaRecovery.Materialized != 0 {
		logger.Info("materialized ontology snapshots for legacy project heads",
			"projects", schemaRecovery.Projects, "materialized", schemaRecovery.Materialized)
	}

	codexCommand, err := nativeCodexAppServerCommand(runtimePaths)
	if err != nil {
		return err
	}
	client, err := codex.Start(ctx, codex.Config{
		Command: codexCommand.Path,
		Args:    codexCommand.Args,
		Dir:     paths.Root,
		Env:     []string{"CODEX_HOME=" + paths.CodexHome},
		ClientInfo: codex.ClientInfo{
			Name: "aetherops", Title: "AetherOps", Version: version,
		},
		AfterStart: runtimeSupervisor.Assign,
	})
	if err != nil {
		return fmt.Errorf("start required Codex App Server: %w", err)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, client.Close(shutdownCtx))
	}()

	workspace := filepath.Join(paths.Root, "workspace")
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		return err
	}
	protocol, err := integration.NewCodexAdapter(client, workspace)
	if err != nil {
		return err
	}
	engineeringService, err := engineering.New(engineering.Config{
		DB: db, CAS: objects, Runtime: runtimePaths, WorkspaceRoot: workspace,
	})
	if err != nil {
		return fmt.Errorf("start app-owned engineering executor: %w", err)
	}
	coreAuthorizer := &approval.CoreAuthorizer{DB: db}
	engine, err := research.New(research.Config{
		DB: db, CAS: objects, Protocol: protocol, ProductBuild: productBuild,
		XFOILRunner: engineeringService, XFOILAuthorizer: coreAuthorizer,
	})
	if err != nil {
		return err
	}
	credentials := secret.NewStore()
	embeddings := newEmbeddingClient(credentials)
	memoryService := &memoryindex.Service{DB: db, CAS: objects, Embedder: embeddings}
	knowledgeService.Memory = memoryService
	knowledgeService.Extraction = protocol
	onSucceeded := func(runCtx context.Context, runID string) error {
		if err := memoryService.IndexRun(runCtx, runID); err != nil {
			// A succeeded report that was not indexed must not leave the prior
			// graph looking current. The run remains succeeded; retrieval blocks
			// until a later verified materialization repairs the projection.
			failureCtx := context.WithoutCancel(runCtx)
			run, runErr := db.Run(failureCtx, runID)
			if runErr != nil {
				return errors.Join(err, fmt.Errorf("load run after memory indexing failure: %w", runErr))
			}
			head, headErr := db.ActiveKnowledgeGeneration(failureCtx, run.ProjectID)
			if headErr != nil {
				return errors.Join(err, fmt.Errorf("load knowledge head after memory indexing failure: %w", headErr))
			}
			if head.Status != store.KnowledgeHeadFailed {
				_, staleErr := db.SetKnowledgeHeadStatus(
					failureCtx, run.ProjectID, head.KnowledgeRevision, store.KnowledgeHeadStale,
					"successful run memory indexing failed; knowledge materialization required: "+err.Error(),
				)
				if staleErr != nil {
					return errors.Join(err, fmt.Errorf("mark knowledge head stale: %w", staleErr))
				}
			}
			return err
		}
		return knowledgeService.AdoptRun(runCtx, runID)
	}
	recovery, err := knowledgeService.RecoverSuccessfulRunAdoptions(ctx)
	if err != nil {
		return fmt.Errorf("recover successful-run adoption before dispatch: %w", err)
	}
	if recovery.Failed != 0 {
		logger.Warn("successful-run adoption remains fail-closed after startup recovery",
			"pending", recovery.Pending, "recovered", recovery.Recovered,
			"failed", recovery.Failed, "failures", recovery.Failures)
	} else if recovery.Recovered != 0 {
		logger.Info("recovered successful-run adoption before dispatch",
			"pending", recovery.Pending, "recovered", recovery.Recovered,
			"quarantined_candidates", recovery.QuarantinedCandidates)
	}
	dispatcher := &dispatch.Dispatcher{DB: db, Threads: protocol, Configurations: protocol,
		Executor: integration.ResearchExecutor{Engine: engine, OnSucceeded: onSucceeded}}
	if err := dispatcher.Start(ctx); err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, dispatcher.Shutdown(shutdownCtx))
	}()

	router := &approval.Router{DB: db, CAS: objects, Client: client,
		AllowedUploadRoots: []string{workspace, paths.CAS}}
	routerResult := make(chan error, 1)
	go func() { routerResult <- router.Run(ctx) }()
	browserController, err := integration.NewBrowserController(host, client.InterruptAll, func(observeCtx context.Context) error {
		_, err := (managedruntime.StdioBrowserProbe{
			Endpoint: fmt.Sprintf("http://127.0.0.1:%d", gate.Internet.CDPPort),
			Timeout:  30 * time.Second, AfterStart: runtimeSupervisor.Assign,
			RequirePageSnapshot: true,
		}).ProbeBrowser(observeCtx, runtimePaths)
		return err
	}, func() error {
		return appdata.ScheduleInternetProfileReset(paths)
	})
	if err != nil {
		return err
	}
	scheduler := &schedule.Service{DB: db, Clock: schedule.SystemClock{}}
	var releaseBrowserObservation func(context.Context) (any, error)
	if releaseDescriptorPath != "" {
		releaseBrowserObservation = func(observeCtx context.Context) (any, error) {
			return (managedruntime.StdioBrowserProbe{
				Endpoint: fmt.Sprintf("http://127.0.0.1:%d", gate.Internet.CDPPort),
				Timeout:  30 * time.Second, AfterStart: runtimeSupervisor.Assign,
				RequirePageSnapshot: true,
			}).ProbeBrowser(observeCtx, runtimePaths)
		}
	}
	server := &api.Server{
		DB: db, CAS: objects, Runs: dispatcher, Chat: dispatcher, ChatHistory: dispatcher, Models: protocol, ContextUsage: protocol, Browser: browserController,
		ProductBuild: productBuild,
		Credentials:  credentials, Login: integration.DeviceLogin{Client: client},
		CodexAccount:    integration.DeviceLogin{Client: client},
		Memory:          memoryService,
		Knowledge:       knowledgeService,
		ProjectCreator:  knowledgeService,
		ApprovalDecider: approval.CombinedController{Core: coreAuthorizer, Codex: router}, Scheduler: scheduler, Shell: ui.NewHandler(),
		ToolStudio:      toolService,
		OpenExternalURL: desktop.OpenExternalURL,
		RuntimeState: func() (any, []string) {
			return updater.Snapshot(), updater.Warnings()
		},
		ReleaseBrowserObservation: releaseBrowserObservation,
		OpenAIKeyStored: func() {
			go func() {
				recovered, err := knowledgeService.RecoverSuccessfulRunAdoptions(context.Background())
				if err != nil {
					logger.Error("successful-run adoption recovery failed after storing the OpenAI key", "error", err)
					return
				}
				if recovered.Failed != 0 {
					logger.Warn("successful-run adoption remains fail-closed after storing the OpenAI key",
						"pending", recovered.Pending, "recovered", recovered.Recovered,
						"failed", recovered.Failed, "failures", recovered.Failures)
				}
			}()
		},
	}
	endpoint, err := server.Start(ctx)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, server.Shutdown(shutdownCtx))
	}()
	if releaseDescriptorPath != "" {
		cleanupDescriptor, descriptorErr := publishReleaseEvalSessionDescriptor(
			releaseDescriptorPath, endpoint, server.Token(), productBuild,
		)
		if descriptorErr != nil {
			return descriptorErr
		}
		defer func() { returnErr = errors.Join(returnErr, cleanupDescriptor()) }()
	}
	state := host.State()
	if state.ActiveSurface != desktop.SurfaceShell || state.ActiveTab == 0 {
		return errors.New("desktop shell surface is unavailable")
	}
	if err := host.Navigate(ctx, state.ActiveTab, endpoint+"/#access_token="+server.Token()); err != nil {
		return fmt.Errorf("open AetherOps shell: %w", err)
	}

	schedulerResult := make(chan error, 1)
	go func() { schedulerResult <- runScheduler(ctx, scheduler, dispatcher, logger) }()
	downloadResult := make(chan error, 1)
	go func() {
		downloadResult <- (&download.Watcher{Directory: paths.Downloads, DB: db, CAS: objects}).Run(ctx)
	}()
	updaterResult := make(chan error, 1)
	go func() { updaterResult <- updater.Run(ctx) }()
	select {
	case <-ctx.Done():
		return nil
	case err := <-hostResult:
		return err
	case err := <-routerResult:
		if errors.Is(err, context.Canceled) {
			return nil
		}
		return err
	case err := <-schedulerResult:
		return err
	case err := <-downloadResult:
		return err
	case err := <-updaterResult:
		return err
	}
}

func setupModeAllowed(releaseDescriptorPath string) bool {
	return strings.TrimSpace(releaseDescriptorPath) == ""
}

func handleSecondaryApplicationInstance(ctx context.Context, releaseDescriptorPath string) error {
	if strings.TrimSpace(releaseDescriptorPath) != "" {
		return errors.New("release evaluation session requires a new primary AetherOps process; close the existing instance first")
	}
	return activatePrimaryWindow(ctx, applicationID)
}

func activatePrimaryWindow(ctx context.Context, applicationID string) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(15 * time.Second)
	defer timeout.Stop()
	for {
		activated, err := desktop.ActivateExistingWindow(applicationID)
		if err != nil {
			return fmt.Errorf("activate existing AetherOps window: %w", err)
		}
		if activated {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return errors.New("primary AetherOps process did not create its window within 15 seconds")
		case <-ticker.C:
		}
	}
}

func runSetupApplication(
	ctx context.Context,
	paths appdata.Paths,
	db *store.DB,
	objects *cas.Store,
	host *desktop.Host,
	hostResult <-chan error,
	updater *managedruntime.Updater,
) (returnErr error) {
	browserController, err := integration.NewBrowserController(host, nil, nil, func() error {
		return appdata.ScheduleInternetProfileReset(paths)
	})
	if err != nil {
		return err
	}
	memoryService := &memoryindex.Service{DB: db}
	server := &api.Server{
		DB: db, CAS: objects, Browser: browserController,
		Memory: memoryService, Credentials: secret.NewStore(), Shell: ui.NewHandler(),
		RuntimeWarnings: []string{
			"관리 런타임이 아직 준비되지 않아 연구 실행과 Codex 로그인이 잠겨 있습니다. 검증된 후보가 준비되면 AetherOps를 다시 시작하세요.",
		},
		RuntimeState: func() (any, []string) {
			return updater.Snapshot(), updater.Warnings()
		},
	}
	endpoint, err := server.Start(ctx)
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, server.Shutdown(shutdownCtx))
	}()
	state := host.State()
	if state.ActiveSurface != desktop.SurfaceShell || state.ActiveTab == 0 {
		return errors.New("desktop shell surface is unavailable")
	}
	if err := host.Navigate(ctx, state.ActiveTab, endpoint+"/#access_token="+server.Token()); err != nil {
		return fmt.Errorf("open AetherOps setup shell: %w", err)
	}

	downloadResult := make(chan error, 1)
	go func() {
		downloadResult <- (&download.Watcher{Directory: paths.Downloads, DB: db, CAS: objects}).Run(ctx)
	}()
	updaterResult := make(chan error, 1)
	go func() { updaterResult <- updater.Run(ctx) }()
	select {
	case <-ctx.Done():
		return nil
	case err := <-hostResult:
		return err
	case err := <-downloadResult:
		return err
	case err := <-updaterResult:
		return err
	}
}

func runScheduler(ctx context.Context, scheduler *schedule.Service, dispatcher *dispatch.Dispatcher, logger *slog.Logger) error {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		if err := scheduler.Tick(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("schedule tick failed", "error", err)
		}
		if err := dispatcher.ReloadQueued(ctx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Error("reload queued runs failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func runInternalMCP(ctx context.Context, isolatedDataRoot string) (returnErr error) {
	paths, db, objects, err := openWorkerStorageAt(ctx, isolatedDataRoot)
	if err != nil {
		return err
	}
	defer db.Close()
	runtimePaths, err := resolveManagedRuntime(paths)
	if err != nil {
		return err
	}
	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, supervisor.Close()) }()
	script, err := findKnowledgeSidecarEntrypoint()
	if err != nil {
		return err
	}
	sidecar, err := startKnowledgeSidecar(ctx, runtimePaths, script, supervisor.Assign)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, sidecar.Close()) }()
	credentials := secret.NewStore()
	embedder := newEmbeddingClient(credentials)
	knowledgeService := &knowledge.Service{DB: db, CAS: objects, Sidecar: sidecar}
	toolService := &toolstudio.Service{DB: db}
	return (&mcpserver.Server{DB: db, CAS: objects, Embedder: embedder, Knowledge: knowledgeService, ToolStudio: toolService}).Serve(ctx, os.Stdin, os.Stdout)
}

func startKnowledgeSidecar(ctx context.Context, runtimePaths managedruntime.ProcessPaths, script string, assign func(int) error) (*knowledge.Sidecar, error) {
	if runtimePaths.NodeExecutable == "" || runtimePaths.OxigraphModuleDirectory == "" {
		return nil, errors.New("verified Node and Oxigraph runtime paths are required")
	}
	sidecarEnvironment, err := knowledge.IsolatedSidecarEnvironment(append(
		os.Environ(), "AETHEROPS_OXIGRAPH_MODULE="+runtimePaths.OxigraphModuleDirectory,
	))
	if err != nil {
		return nil, err
	}
	return knowledge.StartSidecar(ctx, knowledge.SidecarConfig{
		Command: runtimePaths.NodeExecutable,
		Args:    []string{script},
		Dir:     filepath.Dir(script),
		Env:     sidecarEnvironment,
		AfterStart: func(command *exec.Cmd) error {
			if command.Process == nil {
				return errors.New("Oxigraph sidecar process is unavailable")
			}
			return assign(command.Process.Pid)
		},
	})
}

func findKnowledgeSidecarEntrypoint() (string, error) {
	candidates := []string{}
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), "knowledge-sidecar", "index.cjs"))
	}
	for _, candidate := range candidates {
		info, err := os.Lstat(candidate)
		if err == nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
			return candidate, nil
		}
	}
	return "", errors.New("knowledge-sidecar/index.cjs was not found beside AetherOps")
}

func runEngineeringMCP(ctx context.Context, isolatedDataRoot string) error {
	paths, db, objects, err := openWorkerStorageAt(ctx, isolatedDataRoot)
	if err != nil {
		return err
	}
	defer db.Close()
	runtimePaths, err := resolveManagedRuntime(paths)
	if err != nil {
		return err
	}
	service, err := engineering.New(engineering.Config{
		DB: db, CAS: objects, Runtime: runtimePaths,
		WorkspaceRoot: filepath.Join(paths.Root, "workspace"),
	})
	if err != nil {
		return err
	}
	return (&mcpserver.Server{DB: db, CAS: objects, Engineering: service}).Serve(ctx, os.Stdin, os.Stdout)
}

func runChromeMCP(ctx context.Context, args []string) error {
	if (len(args) != 2 && len(args) != 4) || !strings.HasPrefix(args[0], "--browser-url=") || args[1] != "--no-usage-statistics" {
		return errors.New("chrome-mcp requires the managed loopback browser endpoint")
	}
	isolatedDataRoot := ""
	if len(args) == 4 {
		if args[2] != "--data-root" || strings.TrimSpace(args[3]) == "" {
			return errors.New("chrome-mcp evaluation data root is invalid")
		}
		isolatedDataRoot = args[3]
	}
	endpoint := strings.TrimPrefix(args[0], "--browser-url=")
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" || parsed.User != nil || parsed.Path != "" {
		return errors.New("chrome-mcp browser endpoint must be an explicit IPv4 loopback port")
	}
	var paths appdata.Paths
	if isolatedDataRoot == "" {
		paths, err = appdata.Resolve()
	} else {
		paths, err = appdata.ResolveIsolated(isolatedDataRoot)
	}
	if err != nil {
		return err
	}
	runtimePaths, err := resolveManagedRuntime(paths)
	if err != nil {
		return err
	}
	commandArgs := append(append([]string(nil), runtimePaths.ChromeDevtoolsMCP.Args...), args...)
	command := exec.CommandContext(ctx, runtimePaths.ChromeDevtoolsMCP.Path, commandArgs...)
	processutil.ConfigureNoWindow(command)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}

func nativeCodexAppServerCommand(paths managedruntime.ProcessPaths) (managedruntime.Command, error) {
	packageRoot := filepath.Dir(filepath.Dir(paths.CodexEntrypoint))
	native := filepath.Clean(filepath.Join(
		filepath.Dir(packageRoot),
		"codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
	))
	info, err := os.Lstat(native)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return managedruntime.Command{}, errors.New("verified Codex Windows executable is unavailable")
	}
	return managedruntime.Command{Path: native, Args: []string{"app-server"}}, nil
}

func newEmbeddingClient(credentials *secret.Store) *rag.EmbeddingClient {
	return &rag.EmbeddingClient{
		HTTPClient: &http.Client{Timeout: 45 * time.Second},
		APIKey: func(context.Context) (string, error) {
			value, err := credentials.OpenAIAPIKey()
			if err != nil {
				return "", err
			}
			defer func() {
				for index := range value {
					value[index] = 0
				}
			}()
			return string(value), nil
		},
	}
}

func runGate0(ctx context.Context, isolatedDataRoot string) (returnErr error) {
	paths, err := appdata.ResolveIsolated(isolatedDataRoot)
	if err != nil {
		return err
	}
	proxy, err := browser.StartEgressProxy(browser.Policy{}, slog.Default())
	if err != nil {
		return err
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		returnErr = errors.Join(returnErr, proxy.Close(shutdownCtx))
	}()
	runtimePaths, runtimeErr := resolveManagedRuntime(paths)
	report, gateErr := gate0windows.Run(ctx, gate0windows.Options{
		Config: desktop.Config{
			ApplicationID: "AetherOps.Gate0", WindowTitle: "AetherOps Gate 0",
			ShellUserDataDir: paths.ShellProfile, InternetUserDataDir: paths.InternetProfile,
			InternetProxyURL: "http://" + proxy.Address(), StartHidden: true,
			DownloadDir: paths.Downloads,
		},
		RuntimePaths: runtimePaths, RuntimeResolutionError: runtimeErr,
	})
	encoded, encodeErr := json.MarshalIndent(report, "", "  ")
	if encodeErr == nil {
		_, encodeErr = os.Stdout.Write(append(encoded, '\n'))
	}
	return errors.Join(gateErr, encodeErr)
}

func openStorage(ctx context.Context) (appdata.Paths, *store.DB, *cas.Store, error) {
	return openStorageAt(ctx, "")
}

func openStorageAt(ctx context.Context, isolatedDataRoot string) (appdata.Paths, *store.DB, *cas.Store, error) {
	return openStorageWith(ctx, isolatedDataRoot, store.Open)
}

func openWorkerStorageAt(ctx context.Context, isolatedDataRoot string) (appdata.Paths, *store.DB, *cas.Store, error) {
	return openStorageWith(ctx, isolatedDataRoot, store.OpenWorker)
}

func openStorageWith(
	ctx context.Context,
	isolatedDataRoot string,
	openDatabase func(context.Context, string) (*store.DB, error),
) (appdata.Paths, *store.DB, *cas.Store, error) {
	var paths appdata.Paths
	var err error
	if strings.TrimSpace(isolatedDataRoot) == "" {
		paths, err = appdata.Resolve()
	} else {
		paths, err = appdata.ResolveIsolated(isolatedDataRoot)
	}
	if err != nil {
		return appdata.Paths{}, nil, nil, err
	}
	db, err := openDatabase(ctx, paths.Database)
	if err != nil {
		return paths, nil, nil, err
	}
	objects, err := cas.Open(paths.CAS)
	if err != nil {
		_ = db.Close()
		return paths, nil, nil, err
	}
	return paths, db, objects, nil
}

func newRuntimeUpdater(
	paths appdata.Paths,
	db *store.DB,
	cdpEndpoint string,
	assign func(int) error,
) (*managedruntime.Updater, error) {
	manifestPath, err := findRuntimeManifest()
	if err != nil {
		return nil, err
	}
	manifest, err := managedruntime.LoadManifest(manifestPath)
	if err != nil {
		return nil, err
	}
	feedURL := strings.TrimSpace(runtimeUpdateFeedURL)
	keyID := strings.TrimSpace(runtimeUpdateKeyID)
	publicKey := strings.TrimSpace(runtimeUpdatePublicKeyBase64)
	rootPath := filepath.Join(paths.Root, "runtimes")
	client := &http.Client{Timeout: 45 * time.Second}
	options := managedruntime.Options{HTTPClient: client}
	var feed *managedruntime.FeedClient
	disabledReason := ""
	switch {
	case feedURL == "" && keyID == "" && publicKey == "":
		disabledReason = "관리 런타임 자동 업데이트가 비활성화되었습니다: 이 빌드에 서명 stable feed URL과 Ed25519 신뢰 키가 구성되지 않았습니다."
	case feedURL == "" || keyID == "" || publicKey == "":
		disabledReason = "관리 런타임 자동 업데이트가 비활성화되었습니다: stable feed 신뢰 설정이 불완전합니다."
	default:
		trustRoot, trustErr := managedruntime.ParseTrustRoot(keyID, publicKey)
		if trustErr != nil {
			disabledReason = "관리 런타임 자동 업데이트가 비활성화되었습니다: " + trustErr.Error()
			break
		}
		parsed, parseErr := url.Parse(feedURL)
		if parseErr != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
			disabledReason = "관리 런타임 자동 업데이트가 비활성화되었습니다: stable feed URL이 안전한 HTTPS URL이 아닙니다."
			break
		}
		feed = &managedruntime.FeedClient{URL: feedURL, TrustRoot: trustRoot, HTTPClient: client}
		options.SignatureVerifier = trustRoot.SignatureVerifier()
		options.CompatibilityProbe = managedruntime.LiveCompatibilityProbe{
			Timeout: 30 * time.Second,
			AppServer: managedruntime.StdioAppServerProbe{
				Timeout: 30 * time.Second, AfterStart: assign,
				Env: []string{"CODEX_HOME=" + paths.CodexHome},
				RequiredModels: []managedruntime.RequiredAppServerModel{
					{Model: codex.SolModel, Effort: codex.SolEffort},
					{Model: codex.TerraModel, Effort: codex.TerraEffort},
				},
			},
			Browser: managedruntime.StdioBrowserProbe{
				Endpoint: cdpEndpoint, Timeout: 30 * time.Second, AfterStart: assign,
				RequirePageSnapshot: true,
			},
		}
	}
	manager, err := managedruntime.Open(rootPath, manifest, options)
	if err != nil {
		return nil, err
	}
	return &managedruntime.Updater{
		Manager: manager, Feed: feed, DisabledReason: disabledReason,
		Idle: db.ApplicationIdle,
	}, nil
}

func resolveManagedRuntime(paths appdata.Paths) (managedruntime.ProcessPaths, error) {
	manifestPath, err := findRuntimeManifest()
	if err != nil {
		return managedruntime.ProcessPaths{}, err
	}
	manifest, err := managedruntime.LoadManifest(manifestPath)
	if err != nil {
		return managedruntime.ProcessPaths{}, err
	}
	roots := []string{filepath.Join(paths.Root, "runtimes")}
	executable, executableErr := os.Executable()
	if executableErr == nil {
		packaged := filepath.Join(filepath.Dir(executable), "runtime")
		if !strings.EqualFold(packaged, roots[0]) {
			roots = append(roots, packaged)
		}
	}
	var errs []error
	for _, root := range roots {
		manager, openErr := managedruntime.Open(root, manifest, managedruntime.Options{})
		if openErr != nil {
			errs = append(errs, fmt.Errorf("open managed runtime %s: %w", root, openErr))
			continue
		}
		processPaths, pathErr := manager.ProcessPaths()
		if pathErr == nil {
			return processPaths, nil
		}
		errs = append(errs, fmt.Errorf("managed runtime %s: %w", root, pathErr))
	}
	return managedruntime.ProcessPaths{}, fmt.Errorf("required pinned runtime is unavailable; no system fallback was used: %w", errors.Join(errs...))
}

func findRuntimeManifest() (string, error) {
	if executable, err := os.Executable(); err == nil {
		path := filepath.Join(filepath.Dir(executable), "runtime-manifest.json")
		if _, statErr := os.Stat(path); statErr == nil {
			return path, nil
		}
	}
	return "", errors.New("runtime-manifest.json was not found beside aetherops.exe")
}
