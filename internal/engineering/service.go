//go:build windows && amd64

package engineering

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/desktop"
	"github.com/djkim0320/Aether-claw/internal/processutil"
	managedruntime "github.com/djkim0320/Aether-claw/internal/runtime"
	"github.com/djkim0320/Aether-claw/internal/store"
	"github.com/djkim0320/Aether-claw/internal/su2host"
)

const maxCapturedLogBytes = 2 << 20

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Config struct {
	DB            *store.DB
	CAS           *cas.Store
	WorkspaceRoot string
	Runtime       managedruntime.ProcessPaths
}

type Service struct {
	db            *store.DB
	cas           *cas.Store
	workspaceRoot string
	runtime       managedruntime.ProcessPaths
	threads       int
	slots         chan struct{}
	projectMu     sync.Mutex
	projects      map[string]*sync.Mutex
}

func New(config Config) (*Service, error) {
	if config.DB == nil || config.CAS == nil || strings.TrimSpace(config.WorkspaceRoot) == "" {
		return nil, errors.New("engineering database, CAS, and workspace root are required")
	}
	paths := []string{
		config.Runtime.OpenVSPScriptExecutable, config.Runtime.VSPAEROExecutable,
		config.Runtime.GmshExecutable, config.Runtime.XFOILExecutable,
		config.Runtime.SU2CFDExecutable,
	}
	for _, path := range paths {
		if err := requireExecutable(path); err != nil {
			return nil, err
		}
	}
	absolute, err := filepath.Abs(config.WorkspaceRoot)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, err
	}
	threads := runtime.NumCPU()
	if threads < 1 {
		threads = 1
	}
	if threads > 16 {
		threads = 16
	}
	return &Service{
		db: config.DB, cas: config.CAS, workspaceRoot: absolute,
		runtime: config.Runtime, threads: threads, slots: make(chan struct{}, 2),
		projects: make(map[string]*sync.Mutex),
	}, nil
}

func requireExecutable(path string) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("a verified engineering executable path is missing")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("verified engineering executable is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("engineering executable must be a regular managed-runtime file")
	}
	return nil
}

func (service *Service) Capabilities(ctx context.Context, runID, attemptID string) ([]Capability, error) {
	if _, err := service.db.ValidateStageCapability(ctx, runID, attemptID); err != nil {
		return nil, err
	}
	definitions := []struct {
		name, version, path string
		cpu                 bool
	}{
		{"openvsp-vspaero", managedruntime.PinnedOpenVSPVersion, service.runtime.OpenVSPScriptExecutable, false},
		{"gmsh", managedruntime.PinnedGmshVersion, service.runtime.GmshExecutable, false},
		{"xfoil", managedruntime.PinnedXFOILVersion, service.runtime.XFOILExecutable, false},
		{"su2-cfd-omp", managedruntime.PinnedSU2Version, service.runtime.SU2CFDExecutable, true},
	}
	capabilities := make([]Capability, 0, len(definitions))
	for _, definition := range definitions {
		hash, err := hashFile(definition.path)
		capability := Capability{
			Name: definition.name, Version: definition.version,
			Executable: definition.path, SHA256: hash, Ready: err == nil,
		}
		if err != nil {
			capability.Detail = err.Error()
		}
		if definition.cpu && !su2CPUCompatible() {
			capability.Ready = false
			capability.Detail = su2CPUIncompatibility(detectSU2CPUFeatures())
		}
		capabilities = append(capabilities, capability)
	}
	return capabilities, nil
}

func (service *Service) EngineeringGet(
	ctx context.Context,
	runID, attemptID, jobID string,
) (JobResult, error) {
	projectID, err := service.db.ValidateStageCapability(ctx, runID, attemptID)
	if err != nil {
		return JobResult{}, err
	}
	job, err := service.db.EngineeringJob(ctx, jobID)
	if err != nil {
		return JobResult{}, err
	}
	if job.RunID != runID || job.ProjectID != projectID || job.Status != "succeeded" || job.ReceiptArtifactID == "" {
		return JobResult{}, errors.New("engineering job is not a succeeded receipt owned by this run")
	}
	return service.readCompleted(ctx, job)
}

type su2CPUFeatures struct {
	AVX2       bool
	FMA        bool
	BMI1       bool
	BMI2       bool
	OSAVXState bool
}

func detectSU2CPUFeatures() su2CPUFeatures {
	observation, err := su2host.ObserveNative()
	if err != nil {
		return su2CPUFeatures{}
	}
	return su2CPUFeatures{
		AVX2: observation.AVX2,
		FMA:  observation.FMA,
		BMI1: observation.BMI1,
		BMI2: observation.BMI2,
		OSAVXState: observation.AVX && observation.XSAVE && observation.OSXSAVE &&
			observation.XMMStateEnabled && observation.YMMStateEnabled,
	}
}

func (features su2CPUFeatures) compatible() bool {
	return features.AVX2 && features.FMA && features.BMI1 && features.BMI2 && features.OSAVXState
}

func su2CPUIncompatibility(features su2CPUFeatures) string {
	missing := make([]string, 0, 5)
	for _, requirement := range []struct {
		name      string
		available bool
	}{
		{"AVX2", features.AVX2},
		{"FMA", features.FMA},
		{"BMI1", features.BMI1},
		{"BMI2", features.BMI2},
		{"OSXSAVE/XMM/YMM state", features.OSAVXState},
	} {
		if !requirement.available {
			missing = append(missing, requirement.name)
		}
	}
	if len(missing) == 0 {
		return ""
	}
	return "SU2 win64-omp requires AVX2, FMA, BMI1, BMI2, and OSXSAVE/XMM/YMM state; missing: " + strings.Join(missing, ", ")
}

func su2CPUCompatible() bool {
	return detectSU2CPUFeatures().compatible()
}

// RequireNativeSU2Host is the single fail-closed preflight used immediately
// before an SU2 job is admitted. It reads CPUID and XCR0 directly and offers no
// configuration or environment override.
func RequireNativeSU2Host() (su2host.Observation, error) {
	return su2host.RequireNative()
}

// NativeSU2HostPreflight produces the typed self-observation exposed by the
// packaged candidate command. It calls the same native preflight as the SU2
// operation and never launches an engineering runtime.
func NativeSU2HostPreflight(executablePath string, observedAt time.Time) (su2host.CandidatePreflightReceipt, error) {
	return su2host.CandidatePreflight(executablePath, observedAt)
}

type operationOutput struct {
	metrics          map[string]any
	files            []outputFile
	executables      []executableReceipt
	exitCodes        []int
	numericallyValid bool
}

type outputFile struct {
	path, role, name, mediaType string
}

func (service *Service) receiptThreads(operation string) int {
	// XFOIL 6.99 exposes no thread-count control and the adapter launches one
	// solver process. Do not claim the service-wide CPU budget in its receipt.
	if operation == "xfoil_polar" {
		return 1
	}
	return service.threads
}

func (service *Service) execute(
	ctx context.Context,
	runID, attemptID, operation, component, version string,
	spec any,
	worker func(context.Context, string) (operationOutput, error),
) (JobResult, error) {
	projectID, err := service.db.ValidateEngineeringCapability(ctx, runID, attemptID)
	if err != nil {
		return JobResult{}, err
	}
	argumentBytes, err := canonicalJSON(spec)
	if err != nil {
		return JobResult{}, err
	}
	argumentDigest := sha256.Sum256(argumentBytes)
	approvalScopeHash := hex.EncodeToString(argumentDigest[:])
	runtimeHash, err := service.runtimeIdentity(component)
	if err != nil {
		return JobResult{}, err
	}
	specBytes, err := json.Marshal(map[string]any{
		"arguments":           json.RawMessage(argumentBytes),
		"operation":           operation,
		"runtime_bundle_hash": runtimeHash,
		"tool_component":      component,
		"tool_version":        version,
	})
	if err != nil {
		return JobResult{}, err
	}
	digest := sha256.Sum256(specBytes)
	specHash := hex.EncodeToString(digest[:])

	projectLock := service.projectLock(projectID)
	projectLock.Lock()
	defer projectLock.Unlock()
	select {
	case service.slots <- struct{}{}:
		defer func() { <-service.slots }()
	case <-ctx.Done():
		return JobResult{}, ctx.Err()
	}
	// BeginEngineeringJob atomically couples the durable external-side-effect
	// boundary to creation of the running job before any worker can start.
	job, execute, err := service.db.BeginEngineeringJob(ctx, store.EngineeringJob{
		ProjectID: projectID, RunID: runID, StageAttemptID: attemptID,
		Operation: operation, SpecJSON: string(specBytes), SpecSHA256: specHash,
		ToolComponent: component, ToolVersion: version, ApprovalScopeHash: approvalScopeHash,
	})
	if err != nil {
		return JobResult{}, err
	}
	if !execute {
		return service.readCompleted(ctx, job)
	}
	jobDirectory, err := service.jobDirectory(projectID, job.ID)
	if err != nil {
		_ = service.db.FailEngineeringJob(ctx, job.ID, err)
		return JobResult{}, err
	}
	started := time.Now().UTC()
	output, executionErr := worker(ctx, jobDirectory)
	if executionErr != nil {
		_ = service.db.FailEngineeringJob(context.Background(), job.ID, executionErr)
		return JobResult{}, executionErr
	}
	artifacts := make([]ArtifactResult, 0, len(output.files)+1)
	links := make([]store.EngineeringJobArtifact, 0, len(output.files)+1)
	for _, file := range output.files {
		artifact, link, err := service.publishFile(ctx, job, jobDirectory, file)
		if err != nil {
			_ = service.db.FailEngineeringJob(context.Background(), job.ID, err)
			return JobResult{}, err
		}
		artifacts = append(artifacts, artifact)
		links = append(links, link)
	}
	receipt := executionReceipt{
		Schema: receiptSchema, JobID: job.ID, RunID: runID,
		StageAttemptID: attemptID, Operation: operation,
		Spec: json.RawMessage(specBytes), SpecSHA256: specHash,
		Executables: output.executables, Threads: service.receiptThreads(operation),
		StartedAt: started, CompletedAt: time.Now().UTC(), ExitCodes: output.exitCodes,
		Executed: true, NumericallyValid: output.numericallyValid,
		Metrics: output.metrics, Artifacts: append([]ArtifactResult(nil), artifacts...),
	}
	receiptBytes, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		_ = service.db.FailEngineeringJob(context.Background(), job.ID, err)
		return JobResult{}, err
	}
	receiptPath := filepath.Join(jobDirectory, "execution-receipt.json")
	if err := os.WriteFile(receiptPath, append(receiptBytes, '\n'), 0o600); err != nil {
		_ = service.db.FailEngineeringJob(context.Background(), job.ID, err)
		return JobResult{}, err
	}
	receiptArtifact, receiptLink, err := service.publishFile(ctx, job, jobDirectory, outputFile{
		path: receiptPath, role: "receipt", name: "execution-receipt.json", mediaType: "application/json",
	})
	if err != nil {
		_ = service.db.FailEngineeringJob(context.Background(), job.ID, err)
		return JobResult{}, err
	}
	artifacts = append(artifacts, receiptArtifact)
	links = append(links, receiptLink)
	if _, err := service.db.CompleteEngineeringJob(ctx, job.ID, receiptArtifact.ArtifactID, links); err != nil {
		return JobResult{}, err
	}
	storedReceipt, err := service.db.Artifact(ctx, receiptArtifact.ArtifactID)
	if err != nil {
		return JobResult{}, err
	}
	provenance, err := core.EngineeringReceiptEvidenceSource(
		storedReceipt.ID, operation, storedReceipt.BlobHash, storedReceipt.CreatedAt,
	)
	if err != nil {
		return JobResult{}, err
	}
	storedReceiptBytes, err := service.cas.ReadVerified(storedReceipt.BlobHash)
	if err != nil {
		return JobResult{}, err
	}
	evidenceHandles, summaryMetrics, err := executionReceiptModelView(operation, storedReceipt.BlobHash, storedReceiptBytes)
	if err != nil {
		return JobResult{}, err
	}
	return JobResult{
		JobID: job.ID, Operation: operation, SpecSHA256: specHash,
		ReceiptArtifactID: storedReceipt.ID,
		Arguments:         append(json.RawMessage(nil), argumentBytes...),
		Status:            "succeeded", Executed: true, ReusedResult: false,
		NumericallyValid: output.numericallyValid, Metrics: output.metrics, SummaryMetrics: summaryMetrics,
		Artifacts: artifacts, Provenance: provenance, EvidenceHandles: evidenceHandles,
	}, nil
}

func (service *Service) readCompleted(ctx context.Context, job store.EngineeringJob) (JobResult, error) {
	if job.Status != "succeeded" || job.ReceiptArtifactID == "" {
		return JobResult{}, errors.New("completed engineering receipt is unavailable")
	}
	artifact, err := service.db.Artifact(ctx, job.ReceiptArtifactID)
	if err != nil {
		return JobResult{}, err
	}
	data, err := service.cas.ReadVerified(artifact.BlobHash)
	if err != nil {
		return JobResult{}, err
	}
	var receipt executionReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return JobResult{}, err
	}
	if receipt.Schema != receiptSchema || receipt.JobID != job.ID || receipt.RunID != job.RunID ||
		receipt.StageAttemptID != job.StageAttemptID || receipt.Operation != job.Operation ||
		receipt.SpecSHA256 != job.SpecSHA256 || !receipt.Executed {
		return JobResult{}, errors.New("engineering execution receipt does not match its immutable job metadata")
	}
	var receiptSpecCompact, databaseSpecCompact bytes.Buffer
	if err := json.Compact(&receiptSpecCompact, receipt.Spec); err != nil {
		return JobResult{}, errors.New("engineering execution receipt contains an invalid canonical specification")
	}
	if err := json.Compact(&databaseSpecCompact, []byte(job.SpecJSON)); err != nil ||
		!bytes.Equal(receiptSpecCompact.Bytes(), databaseSpecCompact.Bytes()) {
		return JobResult{}, errors.New("engineering execution receipt specification does not match the immutable job")
	}
	var storedSpec struct {
		Arguments json.RawMessage `json:"arguments"`
		Operation string          `json:"operation"`
	}
	if err := json.Unmarshal([]byte(job.SpecJSON), &storedSpec); err != nil || len(storedSpec.Arguments) == 0 || storedSpec.Operation != job.Operation {
		return JobResult{}, errors.New("engineering execution receipt contains an invalid canonical specification")
	}
	specDigest := sha256.Sum256([]byte(job.SpecJSON))
	if hex.EncodeToString(specDigest[:]) != job.SpecSHA256 {
		return JobResult{}, errors.New("engineering execution receipt specification hash does not match the job")
	}
	provenance, err := core.EngineeringReceiptEvidenceSource(
		artifact.ID, job.Operation, artifact.BlobHash, artifact.CreatedAt,
	)
	if err != nil {
		return JobResult{}, err
	}
	links, err := service.db.EngineeringJobArtifacts(ctx, job.ID)
	if err != nil {
		return JobResult{}, err
	}
	artifacts := make([]ArtifactResult, 0, len(links))
	for _, link := range links {
		metadata, err := service.db.BlobMetadata(ctx, link.BlobHash)
		if err != nil {
			return JobResult{}, err
		}
		artifacts = append(artifacts, ArtifactResult{
			ArtifactID: link.ArtifactID, Role: link.Role, FileName: link.FileName,
			MediaType: link.MediaType, SHA256: link.BlobHash, Size: metadata.Size,
		})
	}
	evidenceHandles, summaryMetrics, err := executionReceiptModelView(job.Operation, artifact.BlobHash, data)
	if err != nil {
		return JobResult{}, err
	}
	return JobResult{
		JobID: job.ID, Operation: job.Operation, SpecSHA256: job.SpecSHA256,
		ReceiptArtifactID: artifact.ID,
		Arguments:         append(json.RawMessage(nil), storedSpec.Arguments...),
		Status:            job.Status, Executed: receipt.Executed, ReusedResult: true,
		NumericallyValid: receipt.NumericallyValid, Metrics: receipt.Metrics, SummaryMetrics: summaryMetrics,
		Artifacts: artifacts, Provenance: provenance, EvidenceHandles: evidenceHandles,
	}, nil
}

var engineeringArgumentEvidenceKeys = map[string][]string{
	"openvsp_wing_aero": {
		"semi_span_m", "root_chord_m", "taper_ratio", "sweep_deg", "mach",
		"alpha_start_deg", "alpha_end_deg", "alpha_points",
	},
	"openvsp_modify_wing": {"new_sweep_deg"},
	"gmsh_wing_mesh": {
		"semi_span_m", "root_chord_m", "taper_ratio", "sweep_deg", "mesh_size_m",
	},
	"xfoil_polar": {
		"naca", "reynolds", "mach", "alpha_start_deg", "alpha_end_deg", "alpha_step_deg",
		"execution_purpose", "verification_of_job_id", "optimization_objective", "target_cl", "minimum_cm",
		"flap_chord_ratio", "flap_hinge_x_over_c", "flap_hinge_y_over_c", "flap_deflection_deg",
		"ncrit", "iterations", "panel_count",
	},
	"su2_naca0012": {"mach", "alpha_deg", "iterations", "mesh_size_m"},
}

var engineeringMetricEvidencePaths = map[string][][]string{
	"openvsp_wing_aero":   {{"sample_count"}},
	"openvsp_modify_wing": {{"old_sweep_deg"}, {"new_sweep_deg"}},
	"gmsh_wing_mesh":      {{"nodes"}, {"elements"}, {"coherence"}},
	"xfoil_polar": {
		{"sample_count"}, {"requested_point_count"}, {"nonconverged_point_count"}, {"missing_point_count"},
		{"optimization", "objective"}, {"optimization", "target_cl"}, {"optimization", "minimum_cm"},
		{"optimization", "target_reached"},
		{"optimization", "target_metrics", "alpha_deg"}, {"optimization", "target_metrics", "cl"},
		{"optimization", "target_metrics", "cd"}, {"optimization", "target_metrics", "cm_c4"},
		{"optimization", "target_metrics", "flap_deflection_deg"},
		{"optimization", "target_metrics", "constraint_satisfied"},
		{"optimization", "target_metrics", "interpolation", "left", "alpha_deg"},
		{"optimization", "target_metrics", "interpolation", "left", "cl"},
		{"optimization", "target_metrics", "interpolation", "left", "cd"},
		{"optimization", "target_metrics", "interpolation", "left", "cm_c4"},
		{"optimization", "target_metrics", "interpolation", "left_index"},
		{"optimization", "target_metrics", "interpolation", "left_value_hash"},
		{"optimization", "target_metrics", "interpolation", "right", "alpha_deg"},
		{"optimization", "target_metrics", "interpolation", "right", "cl"},
		{"optimization", "target_metrics", "interpolation", "right", "cd"},
		{"optimization", "target_metrics", "interpolation", "right", "cm_c4"},
		{"optimization", "target_metrics", "interpolation", "right_index"},
		{"optimization", "target_metrics", "interpolation", "right_value_hash"},
		{"optimization", "target_metrics", "interpolation", "right_weight"},
		{"optimization_dossier", "schema"},
		{"optimization_dossier", "screening_attempt_count"},
		{"optimization_dossier", "screening_candidate_count"},
		{"optimization_dossier", "succeeded_screening_attempt_count"},
		{"optimization_dossier", "failed_screening_attempt_count"},
		{"optimization_dossier", "screening_panel_count"},
		{"optimization_dossier", "verification_panel_count"},
		{"optimization_dossier", "winner_job_id"},
		{"optimization_dossier", "verification", "workspace_id"},
		{"optimization_dossier", "verification", "screening_workspace_id"},
		{"optimization_dossier", "verification", "verification_workspace_id"},
		{"optimization_dossier", "verification", "workspaces_distinct"},
		{"optimization_dossier", "verification", "attempt_count"},
		{"optimization_dossier", "verification", "process_spawn_count"},
		{"optimization_dossier", "verification", "execution_count"},
		{"optimization_dossier", "verification", "retry_count"},
		{"optimization_dossier", "verification", "isolated_workspace"},
		{"optimization_verification", "screening_attempt_count"},
		{"optimization_verification", "screening_candidate_count"},
		{"optimization_verification", "succeeded_screening_attempt_count"},
		{"optimization_verification", "failed_screening_attempt_count"},
		{"optimization_verification", "winner_job_id"},
		{"optimization_verification", "winner_flap_deflection_deg"},
		{"optimization_verification", "agreement"},
	},
	"su2_naca0012": core.SU2MetricEvidencePathsV1(),
}

var engineeringReceiptEvidenceKeys = []string{
	"job_id", "stage_attempt_id", "started_at", "completed_at",
	"threads", "executed", "numerically_valid",
}

// executionReceiptModelView derives a bounded, copy-only model view from the
// immutable receipt. Only operation-specific scalar leaves are exposed. Raw
// solver arrays, aggregate objects, timestamps, executable data, and artifact
// metadata remain in CAS and never consume the engineering_get response.
func executionReceiptModelView(operation, artifactHash string, data []byte) ([]EvidenceHandle, map[string]any, error) {
	if len(artifactHash) != sha256.Size*2 {
		return nil, nil, errors.New("engineering evidence artifact hash is invalid")
	}
	if _, err := hex.DecodeString(artifactHash); err != nil || strings.ToLower(artifactHash) != artifactHash {
		return nil, nil, errors.New("engineering evidence artifact hash is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var receipt map[string]any
	if err := decoder.Decode(&receipt); err != nil || receipt == nil {
		return nil, nil, errors.New("engineering evidence receipt is not a JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, nil, errors.New("engineering evidence receipt has trailing JSON content")
	}
	if receiptOperation, _ := receipt["operation"].(string); receiptOperation != operation {
		return nil, nil, errors.New("engineering evidence receipt operation does not match the job")
	}
	argumentKeys, argumentContract := engineeringArgumentEvidenceKeys[operation]
	metricPaths, metricContract := engineeringMetricEvidencePaths[operation]
	if !argumentContract || !metricContract {
		return nil, nil, fmt.Errorf("engineering operation %q has no bounded model evidence contract", operation)
	}
	handles := make([]EvidenceHandle, 0, len(argumentKeys)+len(metricPaths))
	spec, _ := receipt["spec"].(map[string]any)
	arguments, _ := spec["arguments"].(map[string]any)
	for _, key := range argumentKeys {
		value, exists := arguments[key]
		if !exists {
			continue
		}
		if err := appendReceiptScalarHandle(&handles, artifactHash,
			"/spec/arguments/"+escapeEvidencePointerToken(key), value); err != nil {
			return nil, nil, err
		}
	}
	metrics, _ := receipt["metrics"].(map[string]any)
	summary := make(map[string]any)
	provenance := make(map[string]any)
	for _, key := range engineeringReceiptEvidenceKeys {
		value, exists := receipt[key]
		if !exists {
			continue
		}
		pointer := "/" + escapeEvidencePointerToken(key)
		if err := appendReceiptScalarHandle(&handles, artifactHash, pointer, value); err != nil {
			return nil, nil, err
		}
		provenance[key] = value
	}
	if len(provenance) > 0 {
		summary["execution_provenance"] = provenance
	}
	for _, path := range metricPaths {
		value, exists := nestedReceiptValue(metrics, path)
		if !exists {
			continue
		}
		pointer := "/metrics"
		for _, token := range path {
			pointer += "/" + escapeEvidencePointerToken(token)
		}
		if err := appendReceiptScalarHandle(&handles, artifactHash, pointer, value); err != nil {
			return nil, nil, err
		}
		setNestedSummaryValue(summary, path, value)
	}
	return handles, summary, nil
}

func appendReceiptScalarHandle(handles *[]EvidenceHandle, artifactHash, pointer string, value any) error {
	switch value.(type) {
	case string, bool, json.Number:
	default:
		return fmt.Errorf("engineering evidence allowlist path %s is not a scalar", pointer)
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode engineering evidence value %s: %w", pointer, err)
	}
	digest := sha256.Sum256(canonical)
	*handles = append(*handles, EvidenceHandle{
		Kind: core.KnowledgeEvidenceEngineering, ArtifactHash: artifactHash,
		JSONPointer: pointer, ValueHash: hex.EncodeToString(digest[:]),
	})
	return nil
}

func nestedReceiptValue(root map[string]any, path []string) (any, bool) {
	var current any = root
	for _, token := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[token]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func setNestedSummaryValue(root map[string]any, path []string, value any) {
	current := root
	for _, token := range path[:len(path)-1] {
		next, ok := current[token].(map[string]any)
		if !ok {
			next = make(map[string]any)
			current[token] = next
		}
		current = next
	}
	current[path[len(path)-1]] = value
}

func escapeEvidencePointerToken(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func (service *Service) projectLock(projectID string) *sync.Mutex {
	service.projectMu.Lock()
	defer service.projectMu.Unlock()
	lock := service.projects[projectID]
	if lock == nil {
		lock = &sync.Mutex{}
		service.projects[projectID] = lock
	}
	return lock
}

func (service *Service) jobDirectory(projectID, jobID string) (string, error) {
	for _, part := range []string{projectID, jobID} {
		if !safeID.MatchString(part) {
			return "", errors.New("engineering workspace identifier is invalid")
		}
	}
	// The database is authoritative for the run and stage relationship. Keeping
	// those IDs in the filesystem path only consumes the legacy MAX_PATH budget
	// required by OpenVSP 3.50.4, without adding isolation or audit value.
	path := filepath.Join(service.workspaceRoot, "engineering", projectID, jobID)
	relative, err := filepath.Rel(service.workspaceRoot, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("engineering workspace escaped its root")
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return "", err
	}
	return path, nil
}

func (service *Service) publishFile(
	ctx context.Context, job store.EngineeringJob, root string, file outputFile,
) (ArtifactResult, store.EngineeringJobArtifact, error) {
	absolute, err := filepath.Abs(file.path)
	if err != nil {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, err
	}
	relative, err := filepath.Rel(root, absolute)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, errors.New("engineering output escaped its job workspace")
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() == 0 {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, errors.New("engineering output is not a non-empty regular file")
	}
	fileHandle, err := os.Open(absolute)
	if err != nil {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, err
	}
	receipt, putErr := service.cas.PutReader(fileHandle)
	closeErr := fileHandle.Close()
	if err := errors.Join(putErr, closeErr); err != nil {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, err
	}
	if _, err := service.cas.ReadVerified(receipt.Hash); err != nil {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, err
	}
	artifact, err := service.db.PublishArtifact(ctx, job.RunID, job.StageAttemptID,
		"engineering."+job.Operation+"."+file.role, file.mediaType, receipt)
	if err != nil {
		return ArtifactResult{}, store.EngineeringJobArtifact{}, err
	}
	result := ArtifactResult{
		ArtifactID: artifact.ID, Role: file.role, FileName: file.name,
		MediaType: file.mediaType, SHA256: receipt.Hash, Size: receipt.Size,
	}
	link := store.EngineeringJobArtifact{
		ArtifactID: artifact.ID, Role: file.role, FileName: file.name,
		MediaType: file.mediaType, BlobHash: receipt.Hash,
	}
	return result, link, nil
}

type processResult struct {
	stdout, stderr string
	exitCode       int
}

func (service *Service) runCommand(
	ctx context.Context, directory, executable, stdin string, environment []string, args ...string,
) (processResult, error) {
	command := exec.CommandContext(ctx, executable, args...)
	processutil.ConfigureNoWindow(command)
	command.Dir = directory
	command.Env = append(os.Environ(), environment...)
	if stdin != "" {
		command.Stdin = strings.NewReader(stdin)
	}
	stdout := newTailBuffer(maxCapturedLogBytes)
	stderr := newTailBuffer(maxCapturedLogBytes)
	command.Stdout, command.Stderr = stdout, stderr
	supervisor, err := desktop.NewProcessSupervisor()
	if err != nil {
		return processResult{}, err
	}
	defer supervisor.Close()
	if err := command.Start(); err != nil {
		return processResult{}, err
	}
	if err := supervisor.Assign(command.Process.Pid); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return processResult{}, err
	}
	waitErr := command.Wait()
	result := processResult{stdout: stdout.String(), stderr: stderr.String(), exitCode: 0}
	if waitErr != nil {
		var exitError *exec.ExitError
		if errors.As(waitErr, &exitError) {
			result.exitCode = exitError.ExitCode()
		}
		return result, fmt.Errorf("%s exited with code %d: %s", filepath.Base(executable), result.exitCode,
			lastUsefulLine(result.stderr+"\n"+result.stdout))
	}
	return result, nil
}

func executableInfo(component, version, path string, argv []string) (executableReceipt, error) {
	hash, err := hashFile(path)
	if err != nil {
		return executableReceipt{}, err
	}
	return executableReceipt{Component: component, Version: version, SHA256: hash, Argv: argv}, nil
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var normalized map[string]any
	if err := json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	return json.Marshal(normalized)
}

func (service *Service) runtimeIdentity(component string) (string, error) {
	paths := []string{}
	switch component {
	case "openvsp":
		paths = []string{service.runtime.OpenVSPScriptExecutable, service.runtime.VSPAEROExecutable}
	case "gmsh":
		paths = []string{service.runtime.GmshExecutable}
	case "xfoil":
		paths = []string{service.runtime.XFOILExecutable}
	case "su2":
		paths = []string{service.runtime.GmshExecutable, service.runtime.SU2CFDExecutable}
	default:
		return "", fmt.Errorf("unknown engineering runtime component %q", component)
	}
	sort.Strings(paths)
	hasher := sha256.New()
	for _, path := range paths {
		hash, err := hashFile(path)
		if err != nil {
			return "", err
		}
		_, _ = io.WriteString(hasher, filepath.Base(path)+"\x00"+hash+"\n")
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func writeLog(path string, result processResult) error {
	content := "STDOUT\n" + result.stdout + "\nSTDERR\n" + result.stderr
	return os.WriteFile(path, []byte(content), 0o600)
}

func finite(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

func lastUsefulLine(value string) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) == 0 {
		return "no diagnostic output"
	}
	line := strings.TrimSpace(lines[len(lines)-1])
	if len(line) > 500 {
		line = line[len(line)-500:]
	}
	return line
}

type tailBuffer struct {
	limit int
	data  []byte
}

func newTailBuffer(limit int) *tailBuffer { return &tailBuffer{limit: limit} }

func (buffer *tailBuffer) Write(data []byte) (int, error) {
	length := len(data)
	if length >= buffer.limit {
		buffer.data = append(buffer.data[:0], data[length-buffer.limit:]...)
		return length, nil
	}
	if overflow := len(buffer.data) + length - buffer.limit; overflow > 0 {
		copy(buffer.data, buffer.data[overflow:])
		buffer.data = buffer.data[:len(buffer.data)-overflow]
	}
	buffer.data = append(buffer.data, data...)
	return length, nil
}

func (buffer *tailBuffer) String() string { return string(bytes.Clone(buffer.data)) }
