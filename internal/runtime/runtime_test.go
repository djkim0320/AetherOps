package runtime

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCheckedInManifestPinsRequiredManagedRuntimes(t *testing.T) {
	manifest, err := LoadManifest(filepath.Join("..", "..", "runtime-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Channel != "stable" || manifest.CheckedAtMostEvery != "24h" {
		t.Fatalf("unexpected stable check policy: %#v", manifest)
	}
	if manifest.Components.Codex.Version != PinnedCodexVersion ||
		manifest.Components.Node.Version != PinnedNodeVersion ||
		manifest.Components.ChromeDevtoolsMCP.Version != PinnedChromeDevtoolsMCPVersion ||
		manifest.Components.Oxigraph.Version != PinnedOxigraphVersion ||
		manifest.Components.OpenVSP.Version != PinnedOpenVSPVersion ||
		manifest.Components.Gmsh.Version != PinnedGmshVersion ||
		manifest.Components.XFOIL.Version != PinnedXFOILVersion ||
		manifest.Components.SU2.Version != PinnedSU2Version {
		t.Fatalf("managed runtime pins = %#v", manifest.Components)
	}
}

func TestStageRejectsHTTPSDowngradeAndQuarantinesCandidate(t *testing.T) {
	insecure := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer insecure.Close()
	contents := testContents()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/node" {
			http.Redirect(writer, request, insecure.URL+"/node", http.StatusFound)
			return
		}
		writeArtifact(t, writer, contents[strings.TrimPrefix(request.URL.Path, "/")])
	}))
	defer secure.Close()

	manager := newTestManager(t, secure.Client(), acceptTestSignature, testLifecycleProbe(time.Now()))
	candidate, err := manager.Stage(context.Background(), testRelease("https-downgrade", secure.URL, contents))
	if err == nil {
		t.Fatal("Stage succeeded after an HTTPS-to-HTTP redirect")
	}
	if candidate.Status != CandidateQuarantined || !strings.Contains(candidate.Path, filepath.Join("candidates", "quarantine")) {
		t.Fatalf("candidate was not quarantined: %#v", candidate)
	}
	if _, err := manager.ProcessPaths(); !errors.Is(err, ErrNoActiveRuntime) {
		t.Fatalf("ProcessPaths error = %v, want no active managed runtime", err)
	}
	warnings, err := manager.Warnings()
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || warnings[0].Code != "download-or-hash-verification-failed" {
		t.Fatalf("persistent warnings = %#v", warnings)
	}
}

func TestStageRejectsSHA256AndNPMSRIWithoutPublishingPartialPayload(t *testing.T) {
	contents := testContents()
	secure := artifactTLSServer(t, contents)
	defer secure.Close()

	for _, test := range []struct {
		name   string
		mutate func(*Release)
		absent string
	}{
		{
			name: "sha256",
			mutate: func(release *Release) {
				release.Artifacts[0].SHA256 = strings.Repeat("0", sha256.Size*2)
			},
			absent: "node.payload",
		},
		{
			name: "npm-sri",
			mutate: func(release *Release) {
				release.Artifacts[1].NPMIntegrity = sri([]byte("different bytes"))
			},
			absent: "codex.payload",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := newTestManager(t, secure.Client(), acceptTestSignature, testLifecycleProbe(time.Now()))
			release := testRelease("bad-"+test.name, secure.URL, contents)
			test.mutate(&release)
			candidate, err := manager.Stage(context.Background(), release)
			if err == nil {
				t.Fatal("Stage succeeded with invalid integrity metadata")
			}
			if candidate.Status != CandidateQuarantined || candidate.Failure != "download-or-hash-verification-failed" {
				t.Fatalf("candidate = %#v", candidate)
			}
			if _, err := os.Stat(filepath.Join(candidate.Path, test.absent)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid payload was published: %v", err)
			}
			temporary, err := filepath.Glob(filepath.Join(candidate.Path, ".*-payload-*.tmp"))
			if err != nil {
				t.Fatal(err)
			}
			if len(temporary) != 0 {
				t.Fatalf("temporary candidate payloads remain: %v", temporary)
			}
		})
	}
}

func TestMissingOrFailedSignatureVerifierNeverReachesPending(t *testing.T) {
	contents := testContents()
	secure := artifactTLSServer(t, contents)
	defer secure.Close()

	for _, test := range []struct {
		name     string
		verifier SignatureVerifier
		failure  string
	}{
		{name: "missing", verifier: nil, failure: "signature-verifier-required"},
		{name: "rejected", verifier: func(context.Context, SignatureInput) error { return errors.New("untrusted test signature") }, failure: "signature-verification-failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			manager := newTestManager(t, secure.Client(), test.verifier, testLifecycleProbe(time.Now()))
			candidate, err := manager.Stage(context.Background(), testRelease("signature-"+test.name, secure.URL, contents))
			if err == nil {
				t.Fatal("Stage succeeded without a trusted signature")
			}
			if candidate.Status != CandidateQuarantined || candidate.Failure != test.failure {
				t.Fatalf("candidate = %#v", candidate)
			}
			if _, err := manager.ProcessPaths(); !errors.Is(err, ErrNoActiveRuntime) {
				t.Fatalf("ProcessPaths error = %v, want no active managed runtime", err)
			}
		})
	}
}

func TestArchiveTraversalIsRejectedBeforeCandidateCanBecomePending(t *testing.T) {
	contents := testContents()
	contents["node"] = maliciousZIP(t)
	secure := artifactTLSServer(t, contents)
	defer secure.Close()
	manager := newTestManager(t, secure.Client(), acceptTestSignature, testLifecycleProbe(time.Now()))
	release := testRelease("archive-traversal", secure.URL, contents)
	release.Artifacts[0].Archive = ArchiveZIP
	release.Artifacts[0].Entrypoint = "node.exe"
	candidate, err := manager.Stage(context.Background(), release)
	if err == nil {
		t.Fatal("Stage succeeded with a traversal ZIP")
	}
	if candidate.Status != CandidateQuarantined || candidate.Failure != "runtime-installation-failed" {
		t.Fatalf("candidate = %#v", candidate)
	}
	for _, escaped := range []string{
		filepath.Join(candidate.Path, "escaped.txt"),
		filepath.Join(candidate.Path, "runtime", "escaped.txt"),
	} {
		if _, err := os.Stat(escaped); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("archive wrote outside its target (%s): %v", escaped, err)
		}
	}
}

func TestPendingActivatesOnlyOnNextManagerAndFailedPendingKeepsLastVerifiedState(t *testing.T) {
	contents := testContents()
	secure := artifactTLSServer(t, contents)
	defer secure.Close()
	root := t.TempDir()
	manifest := testManifest()
	options := Options{
		HTTPClient:         secure.Client(),
		SignatureVerifier:  acceptTestSignature,
		CompatibilityProbe: testLifecycleProbe(time.Now()),
	}
	manager, err := Open(root, manifest, options)
	if err != nil {
		t.Fatal(err)
	}

	// The injected probe below is only a state-machine witness for this unit
	// test. This test does not claim an end-to-end product release pass.
	pending, err := manager.Stage(context.Background(), testRelease("first-pending", secure.URL, contents))
	if err != nil {
		t.Fatal(err)
	}
	if pending.Status != CandidatePending {
		t.Fatalf("candidate status = %s, want pending", pending.Status)
	}
	if _, err := os.Stat(manager.Layout().Active); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("active pointer exists before restart activation: %v", err)
	}
	if _, err := manager.ProcessPaths(); !errors.Is(err, ErrNoActiveRuntime) {
		t.Fatalf("ProcessPaths before activation = %v", err)
	}

	// Reopen is the next-start boundary. Only this call publishes active.json.
	restarted, err := Open(root, manifest, options)
	if err != nil {
		t.Fatal(err)
	}
	active, err := restarted.ActivatePending(context.Background(), pending.ID)
	if err != nil {
		t.Fatal(err)
	}
	if active.CandidateID != pending.ID || active.LastVerified[ComponentNode] != PinnedNodeVersion {
		t.Fatalf("active state = %#v", active)
	}
	paths, err := restarted.ProcessPaths()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		paths.NodeExecutable,
		paths.CodexEntrypoint,
		paths.ChromeDevtoolsMCPEntrypoint,
		paths.OxigraphPackageEntrypoint,
		paths.OpenVSPScriptExecutable,
		paths.VSPAEROExecutable,
		paths.VSPAEROOptExecutable,
		paths.GmshExecutable,
		paths.XFOILExecutable,
		paths.SU2CFDExecutable,
	} {
		if !strings.HasPrefix(path, restarted.Layout().Versions+string(filepath.Separator)) {
			t.Fatalf("process path is outside managed versions: %s", path)
		}
	}
	if paths.CodexAppServer.Path != paths.NodeExecutable || len(paths.CodexAppServer.Args) != 2 || paths.CodexAppServer.Args[1] != "app-server" {
		t.Fatalf("unexpected Codex command: %#v", paths.CodexAppServer)
	}
	if paths.SU2SOLExecutable != "" {
		t.Fatalf("optional SU2_SOL path was populated without a managed file: %q", paths.SU2SOLExecutable)
	}

	broken, err := restarted.Stage(context.Background(), testRelease("broken-pending", secure.URL, contents))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(broken.Path, "node.payload"), []byte("modified after probe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.ActivatePending(context.Background(), broken.ID); err == nil {
		t.Fatal("corrupted pending candidate activated")
	}
	stillActive, err := restarted.Active()
	if err != nil {
		t.Fatal(err)
	}
	if stillActive.CandidateID != pending.ID || stillActive.LastVerified[ComponentCodex] != PinnedCodexVersion {
		t.Fatalf("active pointer changed after failed activation: %#v", stillActive)
	}
	quarantinedPath := filepath.Join(restarted.Layout().Candidates, "quarantine", broken.ID, candidateFileName)
	var quarantined Candidate
	if err := readJSON(quarantinedPath, &quarantined); err != nil {
		t.Fatal(err)
	}
	if quarantined.Status != CandidateQuarantined {
		t.Fatalf("failed pending candidate status = %s", quarantined.Status)
	}
	warnings, err := restarted.Warnings()
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) == 0 || warnings[len(warnings)-1].LastVerified[ComponentChromeDevtoolsMCP] != PinnedChromeDevtoolsMCPVersion {
		t.Fatalf("last verified versions were not retained in warning: %#v", warnings)
	}
	stateTemps, err := filepath.Glob(filepath.Join(restarted.Layout().Root, ".state-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(stateTemps) != 0 {
		t.Fatalf("active state left temporary files: %v", stateTemps)
	}
	if err := os.RemoveAll(restarted.Layout().Candidates); err != nil {
		t.Fatal(err)
	}
	readOnlyPaths, err := ResolveProcessPathsReadOnly(root, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if readOnlyPaths.NodeExecutable != paths.NodeExecutable {
		t.Fatalf("read-only runtime resolver changed authenticated paths: %#v", readOnlyPaths)
	}
	if _, err := os.Stat(restarted.Layout().Candidates); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read-only runtime resolver created candidate state: %v", err)
	}
}

func TestCheckDueRequiresIdleAndPersistsOneDayStableInterval(t *testing.T) {
	manager := newTestManager(t, nil, nil, nil)
	now := time.Date(2026, time.August, 6, 2, 0, 0, 0, time.UTC)
	if due, err := manager.CheckDue(now, false); err != nil || due {
		t.Fatalf("busy check = %v, %v; want false, nil", due, err)
	}
	if due, err := manager.CheckDue(now, true); err != nil || !due {
		t.Fatalf("first idle check = %v, %v; want true, nil", due, err)
	}
	if err := manager.RecordCheck(now); err != nil {
		t.Fatal(err)
	}
	status, err := manager.Status()
	if err != nil || status.LastCheckedAt == nil || !status.LastCheckedAt.Equal(now) {
		t.Fatalf("durable runtime check status = %#v, %v", status.LastCheckedAt, err)
	}
	if due, err := manager.CheckDue(now.Add(23*time.Hour+59*time.Minute), true); err != nil || due {
		t.Fatalf("early idle check = %v, %v; want false, nil", due, err)
	}
	if due, err := manager.CheckDue(now.Add(24*time.Hour), true); err != nil || !due {
		t.Fatalf("daily idle check = %v, %v; want true, nil", due, err)
	}
}

func TestStdioAppServerProbeUsesARealChildProcessHandshake(t *testing.T) {
	if os.Getenv("AETHEROPS_RUNTIME_APP_SERVER_HELPER") == "1" {
		runAppServerProbeHelper(t)
		return
	}
	t.Setenv("AETHEROPS_RUNTIME_APP_SERVER_HELPER", "1")
	t.Setenv("AETHEROPS_RUNTIME_EXPECT_CODEX_HOME", filepath.Join(t.TempDir(), "candidate-codex-home"))
	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), "legacy-codex-home"))
	assigned := false
	probe := StdioAppServerProbe{Timeout: 5 * time.Second, AfterStart: func(pid int) error {
		assigned = pid > 0
		return nil
	}, Env: []string{"CODEX_HOME=" + os.Getenv("AETHEROPS_RUNTIME_EXPECT_CODEX_HOME")}, RequiredModels: []RequiredAppServerModel{
		{Model: "gpt-5.6-sol", Effort: "xhigh"},
		{Model: "gpt-5.6-terra", Effort: "high"},
	}}
	evidence, err := probe.ProbeAppServer(context.Background(), Command{
		Path: os.Args[0],
		Args: []string{"-test.run=^TestStdioAppServerProbeUsesARealChildProcessHandshake$"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !assigned || !evidence.Executed || !evidence.Compatible || evidence.Observation == "" {
		t.Fatalf("probe evidence = %#v assigned=%v", evidence, assigned)
	}
}

func TestStdioAppServerProbeRejectsMissingRequiredModelEffort(t *testing.T) {
	if os.Getenv("AETHEROPS_RUNTIME_APP_SERVER_HELPER") == "1" {
		runAppServerProbeHelper(t)
		return
	}
	for _, mode := range []string{"missing-terra", "wrong-terra-effort"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("AETHEROPS_RUNTIME_APP_SERVER_HELPER", "1")
			t.Setenv("AETHEROPS_RUNTIME_APP_SERVER_MODE", mode)
			probe := StdioAppServerProbe{Timeout: 5 * time.Second, RequiredModels: []RequiredAppServerModel{
				{Model: "gpt-5.6-sol", Effort: "xhigh"},
				{Model: "gpt-5.6-terra", Effort: "high"},
			}}
			if _, err := probe.ProbeAppServer(context.Background(), Command{
				Path: os.Args[0], Args: []string{"-test.run=^TestStdioAppServerProbeRejectsMissingRequiredModelEffort$"},
			}); err == nil || !strings.Contains(err.Error(), "missing required model") {
				t.Fatalf("incomplete candidate model contract was accepted: %v", err)
			}
		})
	}
}

func runAppServerProbeHelper(t *testing.T) {
	if expected := os.Getenv("AETHEROPS_RUNTIME_EXPECT_CODEX_HOME"); expected != "" && os.Getenv("CODEX_HOME") != expected {
		t.Fatalf("candidate CODEX_HOME=%q, want %q", os.Getenv("CODEX_HOME"), expected)
	}
	reader := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	mode := os.Getenv("AETHEROPS_RUNTIME_APP_SERVER_MODE")
	for reader.Scan() {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(reader.Bytes(), &request); err != nil {
			t.Fatal(err)
		}
		if request.ID == 0 {
			if request.Method != "initialized" {
				t.Fatalf("unexpected notification: %#v", request)
			}
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "stable"}
		case "model/list":
			cursor, _ := request.Params["cursor"].(string)
			if mode == "missing-terra" {
				result = map[string]any{"data": []any{appServerProbeModel("gpt-5.6-sol", "xhigh")}}
			} else if cursor == "" {
				result = map[string]any{
					"data": []any{appServerProbeModel("gpt-5.6-sol", "xhigh")}, "nextCursor": "terra-page",
				}
			} else if cursor == "terra-page" {
				terraEffort := "high"
				if mode == "wrong-terra-effort" {
					terraEffort = "medium"
				}
				result = map[string]any{"data": []any{appServerProbeModel("gpt-5.6-terra", terraEffort)}}
			} else {
				t.Fatalf("unexpected model/list cursor: %q", cursor)
			}
		default:
			t.Fatalf("unexpected App Server request: %#v", request)
		}
		if err := encoder.Encode(map[string]any{"id": request.ID, "result": result}); err != nil {
			t.Fatal(err)
		}
	}
}

func appServerProbeModel(id, effort string) map[string]any {
	return map[string]any{
		"id": id, "hidden": false,
		"supportedReasoningEfforts": []map[string]string{{"reasoningEffort": effort}},
	}
}

func testManifest() Manifest {
	return Manifest{
		Schema:             1,
		Channel:            "stable",
		CheckedAtMostEvery: "24h",
		Components: ManifestComponents{
			Go:    GoComponentManifest{Version: "1.26.5", BuildOnly: true},
			Codex: ComponentManifest{Version: PinnedCodexVersion, Command: "codex app-server"},
			Node:  ComponentManifest{Version: PinnedNodeVersion},
			ChromeDevtoolsMCP: ComponentManifest{
				Version: PinnedChromeDevtoolsMCPVersion,
				Package: "chrome-devtools-mcp",
			},
			Oxigraph: ComponentManifest{Version: PinnedOxigraphVersion, Package: "oxigraph"},
			OpenVSP:  ComponentManifest{Version: PinnedOpenVSPVersion, Command: "vspscript.exe"},
			Gmsh:     ComponentManifest{Version: PinnedGmshVersion, Command: "gmsh.exe"},
			XFOIL:    ComponentManifest{Version: PinnedXFOILVersion, Command: "xfoil.exe"},
			SU2:      ComponentManifest{Version: PinnedSU2Version, Command: "SU2_CFD.exe"},
			WebView2: WebView2Manifest{Channel: "evergreen"},
		},
	}
}

func newTestManager(t *testing.T, client *http.Client, verifier SignatureVerifier, probe CompatibilityProbe) *Manager {
	t.Helper()
	manager, err := Open(t.TempDir(), testManifest(), Options{
		HTTPClient:         client,
		SignatureVerifier:  verifier,
		CompatibilityProbe: probe,
	})
	if err != nil {
		t.Fatal(err)
	}
	return manager
}

func testContents() map[string][]byte {
	return map[string][]byte{
		"node":     []byte("verified node executable"),
		"codex":    []byte("#!/usr/bin/env node\n// verified codex entrypoint\n"),
		"mcp":      []byte("#!/usr/bin/env node\n// verified devtools mcp entrypoint\n"),
		"oxigraph": []byte(`{"name":"oxigraph","version":"0.5.9"}`),
		"openvsp": runtimeZIP(map[string][]byte{
			"vspscript.exe":   []byte("verified OpenVSP script executable"),
			"vspaero.exe":     []byte("verified VSPAERO executable"),
			"vspaero_opt.exe": []byte("verified VSPAERO optimizer executable"),
		}),
		"gmsh":  []byte("verified Gmsh executable"),
		"xfoil": []byte("verified XFOIL executable"),
		"su2":   []byte("verified SU2_CFD executable"),
	}
}

func runtimeZIP(files map[string][]byte) []byte {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry, err := writer.Create(name)
		if err != nil {
			panic(err)
		}
		if _, err := entry.Write(files[name]); err != nil {
			panic(err)
		}
	}
	if err := writer.Close(); err != nil {
		panic(err)
	}
	return buffer.Bytes()
}

func artifactTLSServer(t *testing.T, contents map[string][]byte) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writeArtifact(t, writer, contents[strings.TrimPrefix(request.URL.Path, "/")])
	}))
}

func writeArtifact(t *testing.T, writer http.ResponseWriter, body []byte) {
	t.Helper()
	if body == nil {
		http.NotFound(writer, nil)
		return
	}
	writer.Header().Set("Content-Type", "application/octet-stream")
	writer.Header().Set("Content-Length", stringInt(len(body)))
	if _, err := writer.Write(body); err != nil {
		t.Errorf("write test artifact: %v", err)
	}
}

func stringInt(value int) string {
	return strconv.Itoa(value)
}

func testRelease(id, baseURL string, contents map[string][]byte) Release {
	return Release{
		ID:      id,
		Channel: "stable",
		Artifacts: []Artifact{
			{
				Component:  ComponentNode,
				Version:    PinnedNodeVersion,
				URL:        baseURL + "/node",
				SHA256:     sha256Hex(contents["node"]),
				Signature:  json.RawMessage(`{"testSignature":"node"}`),
				Archive:    ArchiveFile,
				Entrypoint: "node.exe",
			},
			{
				Component:    ComponentCodex,
				Version:      PinnedCodexVersion,
				URL:          baseURL + "/codex",
				SHA256:       sha256Hex(contents["codex"]),
				Signature:    json.RawMessage(`{"testSignature":"codex"}`),
				NPMPackage:   "@openai/codex",
				NPMIntegrity: sri(contents["codex"]),
				Archive:      ArchiveFile,
				Entrypoint:   "codex.js",
			},
			{
				Component:    ComponentChromeDevtoolsMCP,
				Version:      PinnedChromeDevtoolsMCPVersion,
				URL:          baseURL + "/mcp",
				SHA256:       sha256Hex(contents["mcp"]),
				Signature:    json.RawMessage(`{"testSignature":"mcp"}`),
				NPMPackage:   "chrome-devtools-mcp",
				NPMIntegrity: sri(contents["mcp"]),
				Archive:      ArchiveFile,
				Entrypoint:   "mcp.js",
			},
			{
				Component:    ComponentOxigraph,
				Version:      PinnedOxigraphVersion,
				URL:          baseURL + "/oxigraph",
				SHA256:       sha256Hex(contents["oxigraph"]),
				Signature:    json.RawMessage(`{"testSignature":"oxigraph"}`),
				NPMPackage:   "oxigraph",
				NPMIntegrity: sri(contents["oxigraph"]),
				Archive:      ArchiveFile,
				Entrypoint:   "package.json",
			},
			{
				Component:  ComponentOpenVSP,
				Version:    PinnedOpenVSPVersion,
				URL:        baseURL + "/openvsp",
				SHA256:     sha256Hex(contents["openvsp"]),
				Signature:  json.RawMessage(`{"testSignature":"openvsp"}`),
				Archive:    ArchiveZIP,
				Entrypoint: "vspscript.exe",
			},
			{
				Component:  ComponentGmsh,
				Version:    PinnedGmshVersion,
				URL:        baseURL + "/gmsh",
				SHA256:     sha256Hex(contents["gmsh"]),
				Signature:  json.RawMessage(`{"testSignature":"gmsh"}`),
				Archive:    ArchiveFile,
				Entrypoint: "gmsh.exe",
			},
			{
				Component:  ComponentXFOIL,
				Version:    PinnedXFOILVersion,
				URL:        baseURL + "/xfoil",
				SHA256:     sha256Hex(contents["xfoil"]),
				Signature:  json.RawMessage(`{"testSignature":"xfoil"}`),
				Archive:    ArchiveFile,
				Entrypoint: "xfoil.exe",
			},
			{
				Component:  ComponentSU2,
				Version:    PinnedSU2Version,
				URL:        baseURL + "/su2",
				SHA256:     sha256Hex(contents["su2"]),
				Signature:  json.RawMessage(`{"testSignature":"su2"}`),
				Archive:    ArchiveFile,
				Entrypoint: "SU2_CFD.exe",
			},
		},
	}
}

func sha256Hex(bytes []byte) string {
	digest := sha256.Sum256(bytes)
	return hex.EncodeToString(digest[:])
}

func sri(bytes []byte) string {
	digest := sha512.Sum512(bytes)
	return "sha512-" + base64.StdEncoding.EncodeToString(digest[:])
}

func acceptTestSignature(_ context.Context, input SignatureInput) error {
	if input.ArtifactPath == "" || !json.Valid(input.Artifact.Signature) || !validSHA256(input.SHA256) {
		return errors.New("test signature input is invalid")
	}
	return nil
}

func testLifecycleProbe(observed time.Time) CompatibilityProbe {
	return ProbeFunc(func(_ context.Context, paths ProcessPaths) (ProbeReport, error) {
		if paths.NodeExecutable == "" || paths.CodexAppServer.Path == "" || paths.ChromeDevtoolsMCP.Path == "" || paths.OxigraphModuleDirectory == "" ||
			paths.OpenVSPScriptExecutable == "" || paths.VSPAEROExecutable == "" || paths.VSPAEROOptExecutable == "" ||
			paths.GmshExecutable == "" || paths.XFOILExecutable == "" || paths.SU2CFDExecutable == "" {
			return ProbeReport{}, errors.New("candidate process paths are incomplete")
		}
		return ProbeReport{
			AppServer: ProbeEvidence{
				Executed: true, Compatible: true, Observation: "test lifecycle witness", ObservedAt: observed.UTC(),
			},
			Browser: ProbeEvidence{
				Executed: true, Compatible: true, Observation: "test lifecycle witness", ObservedAt: observed.UTC(),
			},
		}, nil
	})
}

func maliciousZIP(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.Create("../escaped.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(entry, "must not escape"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
