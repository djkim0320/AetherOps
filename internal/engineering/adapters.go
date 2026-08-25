//go:build windows && amd64

package engineering

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/djkim0320/AetherOps/internal/core"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/store"
)

var (
	vspCoefficientPattern = regexp.MustCompile(`AETHEROPS_AERO_ALPHA=([-+0-9.eE]+),CL=([-+0-9.eE]+),CD=([-+0-9.eE]+)`)
	gmshNodePattern       = regexp.MustCompile(`(?i)Info\s*:\s*(\d+)\s+nodes`)
	gmshElementPattern    = regexp.MustCompile(`(?i)Info\s*:\s*(\d+)\s+elements`)
	nacaPattern           = regexp.MustCompile(`^[0-9]{4}$`)
	xfoilAlphaPattern     = regexp.MustCompile(`(?i)\ba\s*=\s*([-+0-9.eE]+)`)
)

type AeroSample struct {
	Alpha float64 `json:"alpha_deg"`
	CL    float64 `json:"cl"`
	CD    float64 `json:"cd"`
}

type XFOILSample struct {
	Alpha             float64 `json:"alpha_deg"`
	CL                float64 `json:"cl"`
	CD                float64 `json:"cd"`
	CDPressure        float64 `json:"cd_pressure"`
	CM                float64 `json:"cm_c4"`
	TopTransitionX    float64 `json:"top_transition_x_over_c"`
	BottomTransitionX float64 `json:"bottom_transition_x_over_c"`
}

const (
	xfoilPointConverged    = "converged"
	xfoilPointNonconverged = "nonconverged"
	xfoilPointMissing      = "missing"
)

type XFOILPointStatus struct {
	Alpha  float64 `json:"alpha_deg"`
	Status string  `json:"status"`
	Reason string  `json:"reason,omitempty"`
}

type xfoilSettings struct {
	NCrit      float64
	Iterations int
	PanelCount int
	AlphaGrid  []float64
	Flap       *xfoilFlapSettings
}

type xfoilFlapSettings struct {
	ChordRatio    float64
	HingeXOverC   float64
	HingeYOverC   float64
	DeflectionDeg float64
}

func (service *Service) OpenVSPWingAero(ctx context.Context, spec WingSpec) (JobResult, error) {
	if err := validateWingSpec(spec); err != nil {
		return JobResult{}, err
	}
	return service.execute(ctx, spec.RunID, spec.StageAttemptID, "openvsp_wing_aero",
		"openvsp", managedruntime.PinnedOpenVSPVersion, spec,
		func(parent context.Context, directory string) (operationOutput, error) {
			if err := requireOpenVSPPathBudget(directory,
				"wing_aero.vspscript", "aetherops-wing-results.csv", "aetherops-wing.vspgeom"); err != nil {
				return operationOutput{}, err
			}
			operationCtx, cancel := context.WithTimeout(parent, 8*time.Minute)
			defer cancel()
			scriptPath := filepath.Join(directory, "wing_aero.vspscript")
			script := openVSPAeroScript(spec, service.threads)
			if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
				return operationOutput{}, err
			}
			// OpenVSP 3.50.4's AngelScript loader still uses a legacy Windows
			// path API. The process already runs in the isolated job directory,
			// so pass the script name relative to that directory and avoid a
			// needless MAX_PATH failure in deeper user-data roots.
			args := []string{"-script", filepath.Base(scriptPath)}
			vspInfo, err := executableInfo("openvsp", managedruntime.PinnedOpenVSPVersion,
				service.runtime.OpenVSPScriptExecutable, args)
			if err != nil {
				return operationOutput{}, err
			}
			vspaeroInfo, err := executableInfo("vspaero", managedruntime.PinnedOpenVSPVersion,
				service.runtime.VSPAEROExecutable, nil)
			if err != nil {
				return operationOutput{}, err
			}
			process, err := service.runCommand(operationCtx, directory,
				service.runtime.OpenVSPScriptExecutable, "", nil, args...)
			logPath := filepath.Join(directory, "openvsp-vspaero.log")
			if writeErr := writeLog(logPath, process); writeErr != nil {
				return operationOutput{}, errors.Join(err, writeErr)
			}
			if err != nil {
				return operationOutput{}, err
			}
			combined := process.stdout + "\n" + process.stderr
			if strings.Contains(combined, "AETHEROPS_AERO_ERROR=") {
				return operationOutput{}, errors.New("OpenVSP/VSPAERO emitted a validated error marker")
			}
			matches := vspCoefficientPattern.FindAllStringSubmatch(combined, -1)
			if len(matches) != spec.AlphaPoints {
				return operationOutput{}, fmt.Errorf("VSPAERO returned %d coefficient rows, want %d", len(matches), spec.AlphaPoints)
			}
			samples := make([]AeroSample, 0, len(matches))
			for _, match := range matches {
				alpha, _ := strconv.ParseFloat(match[1], 64)
				cl, _ := strconv.ParseFloat(match[2], 64)
				cd, _ := strconv.ParseFloat(match[3], 64)
				if !finite(alpha, cl, cd) || cd <= 0 {
					return operationOutput{}, errors.New("VSPAERO produced non-finite coefficients or non-positive drag")
				}
				samples = append(samples, AeroSample{Alpha: alpha, CL: cl, CD: cd})
			}
			modelPath := filepath.Join(directory, "aetherops-wing.vsp3")
			polarPath := filepath.Join(directory, "aetherops-wing.polar")
			resultsPath := filepath.Join(directory, "aetherops-wing-results.csv")
			for _, path := range []string{modelPath, polarPath, resultsPath} {
				if info, statErr := os.Stat(path); statErr != nil || info.Size() == 0 {
					return operationOutput{}, fmt.Errorf("OpenVSP/VSPAERO required output is missing: %s", filepath.Base(path))
				}
			}
			return operationOutput{
				metrics: map[string]any{"samples": samples, "sample_count": len(samples)},
				files: []outputFile{
					{scriptPath, "input", "wing_aero.vspscript", "text/plain"},
					{modelPath, "model", "aetherops-wing.vsp3", "application/vnd.openvsp.vsp3"},
					{polarPath, "polar", "aetherops-wing.polar", "text/plain"},
					{resultsPath, "results", "aetherops-wing-results.csv", "text/csv"},
					{logPath, "log", "openvsp-vspaero.log", "text/plain"},
				},
				executables: []executableReceipt{vspInfo, vspaeroInfo},
				exitCodes:   []int{process.exitCode}, numericallyValid: true,
			}, nil
		})
}

func (service *Service) OpenVSPModifyWing(ctx context.Context, spec ModifyWingSpec) (JobResult, error) {
	if spec.RunID == "" || spec.StageAttemptID == "" || spec.SourceArtifactID == "" ||
		!finite(spec.NewSweepDeg) || spec.NewSweepDeg < -20 || spec.NewSweepDeg > 65 {
		return JobResult{}, errors.New("run, collect attempt, source model, and sweep in [-20,65] are required")
	}
	return service.execute(ctx, spec.RunID, spec.StageAttemptID, "openvsp_modify_wing",
		"openvsp", managedruntime.PinnedOpenVSPVersion, spec,
		func(parent context.Context, directory string) (operationOutput, error) {
			if err := requireOpenVSPPathBudget(directory,
				"modify_wing.vspscript", "source.vsp3", "modified.vsp3"); err != nil {
				return operationOutput{}, err
			}
			artifact, metadata, err := service.db.RunArtifact(parent, spec.RunID, spec.SourceArtifactID)
			if err != nil {
				return operationOutput{}, err
			}
			if !strings.Contains(artifact.Kind, "engineering.openvsp_wing_aero.model") ||
				metadata.MediaType != "application/vnd.openvsp.vsp3" {
				return operationOutput{}, errors.New("source artifact is not an OpenVSP wing model from this run")
			}
			data, err := service.cas.ReadVerified(artifact.BlobHash)
			if err != nil {
				return operationOutput{}, err
			}
			sourcePath := filepath.Join(directory, "source.vsp3")
			if err := os.WriteFile(sourcePath, data, 0o600); err != nil {
				return operationOutput{}, err
			}
			scriptPath := filepath.Join(directory, "modify_wing.vspscript")
			if err := os.WriteFile(scriptPath, []byte(openVSPModifyScript(spec.NewSweepDeg)), 0o600); err != nil {
				return operationOutput{}, err
			}
			operationCtx, cancel := context.WithTimeout(parent, 2*time.Minute)
			defer cancel()
			args := []string{"-script", filepath.Base(scriptPath)}
			info, err := executableInfo("openvsp", managedruntime.PinnedOpenVSPVersion,
				service.runtime.OpenVSPScriptExecutable, args)
			if err != nil {
				return operationOutput{}, err
			}
			process, err := service.runCommand(operationCtx, directory,
				service.runtime.OpenVSPScriptExecutable, "", nil, args...)
			logPath := filepath.Join(directory, "openvsp-modify.log")
			if writeErr := writeLog(logPath, process); writeErr != nil {
				return operationOutput{}, errors.Join(err, writeErr)
			}
			if err != nil {
				return operationOutput{}, err
			}
			combined := process.stdout + "\n" + process.stderr
			if strings.Contains(combined, "AETHEROPS_MODIFY_ERROR=") {
				return operationOutput{}, errors.New("OpenVSP model modification emitted an error marker")
			}
			oldSweep, okOld := markerFloat(combined, "AETHEROPS_MODIFY_OLD_SWEEP=")
			newSweep, okNew := markerFloat(combined, "AETHEROPS_MODIFY_NEW_SWEEP=")
			if !okOld || !okNew || math.Abs(newSweep-spec.NewSweepDeg) > 1e-6 {
				return operationOutput{}, errors.New("OpenVSP did not verify the requested sweep change")
			}
			modifiedPath := filepath.Join(directory, "modified.vsp3")
			modified, err := os.ReadFile(modifiedPath)
			if err != nil || len(modified) == 0 {
				return operationOutput{}, errors.New("OpenVSP did not create the modified model")
			}
			if string(data) == string(modified) {
				return operationOutput{}, errors.New("modified OpenVSP model is byte-identical to its source")
			}
			return operationOutput{
				metrics: map[string]any{"old_sweep_deg": oldSweep, "new_sweep_deg": newSweep},
				files: []outputFile{
					{modifiedPath, "model", "modified.vsp3", "application/vnd.openvsp.vsp3"},
					{scriptPath, "input", "modify_wing.vspscript", "text/plain"},
					{logPath, "log", "openvsp-modify.log", "text/plain"},
				},
				executables: []executableReceipt{info}, exitCodes: []int{process.exitCode},
				numericallyValid: true,
			}, nil
		})
}

func (service *Service) GmshWingMesh(ctx context.Context, spec MeshSpec) (JobResult, error) {
	if err := validateMeshSpec(spec); err != nil {
		return JobResult{}, err
	}
	return service.execute(ctx, spec.RunID, spec.StageAttemptID, "gmsh_wing_mesh",
		"gmsh", managedruntime.PinnedGmshVersion, spec,
		func(parent context.Context, directory string) (operationOutput, error) {
			geoPath := filepath.Join(directory, "wing.geo")
			meshPath := filepath.Join(directory, "wing.msh")
			if err := os.WriteFile(geoPath, []byte(gmshWingGeo(spec)), 0o600); err != nil {
				return operationOutput{}, err
			}
			operationCtx, cancel := context.WithTimeout(parent, 3*time.Minute)
			defer cancel()
			args := []string{geoPath, "-2", "-nt", strconv.Itoa(service.threads), "-format", "msh4", "-o", meshPath}
			info, err := executableInfo("gmsh", managedruntime.PinnedGmshVersion,
				service.runtime.GmshExecutable, args)
			if err != nil {
				return operationOutput{}, err
			}
			generate, err := service.runCommand(operationCtx, directory, service.runtime.GmshExecutable, "", nil, args...)
			if err != nil {
				return operationOutput{}, err
			}
			checkArgs := []string{meshPath, "-check", "-nt", strconv.Itoa(service.threads)}
			check, err := service.runCommand(operationCtx, directory, service.runtime.GmshExecutable, "", nil, checkArgs...)
			logPath := filepath.Join(directory, "gmsh.log")
			combinedProcess := processResult{stdout: generate.stdout + "\n" + check.stdout, stderr: generate.stderr + "\n" + check.stderr}
			if writeErr := writeLog(logPath, combinedProcess); writeErr != nil {
				return operationOutput{}, errors.Join(err, writeErr)
			}
			if err != nil {
				return operationOutput{}, err
			}
			combined := combinedProcess.stdout + "\n" + combinedProcess.stderr
			if regexp.MustCompile(`(?im)^\s*Error\s*:`).MatchString(combined) ||
				!strings.Contains(combined, "Done checking mesh coherence") {
				return operationOutput{}, errors.New("Gmsh mesh coherence validation failed")
			}
			nodes, okNodes := markerIntPattern(combined, gmshNodePattern)
			elements, okElements := markerIntPattern(combined, gmshElementPattern)
			if !okNodes || !okElements || nodes <= 0 || elements <= 0 {
				return operationOutput{}, errors.New("Gmsh returned no positive mesh counts")
			}
			return operationOutput{
				metrics: map[string]any{"nodes": nodes, "elements": elements, "coherence": "pass"},
				files: []outputFile{
					{geoPath, "input", "wing.geo", "text/plain"},
					{meshPath, "mesh", "wing.msh", "application/vnd.gmsh"},
					{logPath, "log", "gmsh.log", "text/plain"},
				},
				executables: []executableReceipt{info}, exitCodes: []int{generate.exitCode, check.exitCode},
				numericallyValid: true,
			}, nil
		})
}

func (service *Service) XFOILPolar(ctx context.Context, spec XFOILSpec) (JobResult, error) {
	settings, err := normalizedXFOILSettings(spec)
	if err != nil {
		return JobResult{}, err
	}
	var verification *xfoilVerificationContract
	if spec.ExecutionPurpose == XFOILPurposeIndependentVerification {
		verification, err = service.validateIndependentXFOIL(ctx, spec)
		if err != nil {
			return JobResult{}, err
		}
	}
	result, err := service.execute(ctx, spec.RunID, spec.StageAttemptID, "xfoil_polar",
		"xfoil", managedruntime.PinnedXFOILVersion, spec,
		func(parent context.Context, directory string) (operationOutput, error) {
			// execute holds the project FIFO lock. Rebuild the contract immediately
			// before launching the external process so a screening completion that
			// raced the early request validation cannot change the selected winner.
			if verification != nil {
				locked, err := service.validateIndependentXFOIL(parent, spec)
				if err != nil {
					return operationOutput{}, err
				}
				verification = locked
			}
			input := xfoilInput(spec, settings)
			inputPath := filepath.Join(directory, "xfoil.in")
			if err := os.WriteFile(inputPath, []byte(input), 0o600); err != nil {
				return operationOutput{}, err
			}
			operationCtx, cancel := context.WithTimeout(parent, 12*time.Minute)
			defer cancel()
			info, err := executableInfo("xfoil", managedruntime.PinnedXFOILVersion,
				service.runtime.XFOILExecutable, []string{"< stdin xfoil.in"})
			if err != nil {
				return operationOutput{}, err
			}
			process, err := service.runCommand(operationCtx, directory,
				service.runtime.XFOILExecutable, input, nil)
			logPath := filepath.Join(directory, "xfoil.log")
			if writeErr := writeLog(logPath, process); writeErr != nil {
				return operationOutput{}, errors.Join(err, writeErr)
			}
			if err != nil {
				return operationOutput{}, err
			}
			polarPath := filepath.Join(directory, "polar.txt")
			samples, err := parseXFOILPolar(polarPath)
			if err != nil {
				return operationOutput{}, err
			}
			if len(samples) < 2 {
				return operationOutput{}, errors.New("XFOIL produced fewer than two converged polar points")
			}
			pointStatuses, err := classifyXFOILPoints(settings.AlphaGrid, samples, process.stdout+"\n"+process.stderr)
			if err != nil {
				return operationOutput{}, err
			}
			nonconverged := 0
			missing := 0
			for _, point := range pointStatuses {
				switch point.Status {
				case xfoilPointNonconverged:
					nonconverged++
				case xfoilPointMissing:
					missing++
				}
			}
			normalizedPath := filepath.Join(directory, "polar-status.json")
			normalized, err := json.MarshalIndent(map[string]any{
				"schema": 1, "samples": samples, "points": pointStatuses,
				"requested_point_count": len(settings.AlphaGrid),
				"converged_point_count": len(samples), "nonconverged_point_count": nonconverged,
				"missing_point_count": missing,
			}, "", "  ")
			if err != nil {
				return operationOutput{}, err
			}
			if err := os.WriteFile(normalizedPath, append(normalized, '\n'), 0o600); err != nil {
				return operationOutput{}, err
			}
			geometryPath := filepath.Join(directory, "geometry.dat")
			if info, statErr := os.Stat(geometryPath); statErr != nil || info.Size() == 0 {
				return operationOutput{}, errors.New("XFOIL did not preserve the analyzed airfoil coordinates")
			}
			metrics := map[string]any{
				"samples": samples, "points": pointStatuses,
				"sample_count": len(samples), "requested_point_count": len(settings.AlphaGrid),
				"nonconverged_point_count": nonconverged, "missing_point_count": missing,
			}
			files := []outputFile{
				{inputPath, "input", "xfoil.in", "text/plain"},
				{geometryPath, "geometry", "geometry.dat", "text/plain"},
				{polarPath, "polar", "polar.txt", "text/plain"},
				{normalizedPath, "normalized", "polar-status.json", "application/json"},
				{logPath, "log", "xfoil.log", "text/plain"},
			}
			if spec.ExecutionPurpose != "" {
				optimization, target, err := xfoilOptimizationMetrics(spec, samples)
				if err != nil {
					return operationOutput{}, err
				}
				metrics["optimization"] = optimization
				if verification != nil {
					if target == nil || !target.ConstraintSatisfied {
						return operationOutput{}, errors.New("independent XFOIL verification did not reproduce a feasible target-CL point")
					}
					if err := requireXFOILIndependentTargetAgreement(verification.WinnerTarget, *target); err != nil {
						return operationOutput{}, err
					}
					metrics["optimization_verification"] = map[string]any{
						"screening_attempt_count":           verification.ScreeningAttemptCount,
						"screening_candidate_count":         verification.ScreeningCandidateCount,
						"succeeded_screening_attempt_count": verification.SucceededAttemptCount,
						"failed_screening_attempt_count":    verification.FailedAttemptCount,
						"winner_job_id":                     verification.WinnerJob.ID,
						"winner_flap_deflection_deg":        verification.WinnerTarget.FlapDeflectionDeg,
						"agreement":                         "pass",
					}
					dossierFiles, dossier, err := writeXFOILVerificationDossier(
						directory, *verification, spec, *target, samples,
					)
					if err != nil {
						return operationOutput{}, err
					}
					metrics["optimization_dossier"] = dossier
					files = append(files, dossierFiles...)
				}
			}
			return operationOutput{
				metrics:     metrics,
				files:       files,
				executables: []executableReceipt{info}, exitCodes: []int{process.exitCode},
				numericallyValid: true,
			}, nil
		})
	if err != nil {
		return JobResult{}, err
	}
	if verification != nil {
		if err := service.validateIndependentXFOILReadback(ctx, spec, result, *verification); err != nil {
			return JobResult{}, err
		}
	}
	return result, nil
}

// CanonicalXFOILScreeningArguments returns the exact JSON object later hashed
// by execute. Research uses this same implementation to build the durable
// per-cell approval scopes, eliminating a second model-authored encoding.
func (service *Service) CanonicalXFOILScreeningArguments(
	runID, attemptID string,
	plan core.XFOILScreeningPlan,
	point core.XFOILOperatingPoint,
	deflection float64,
) ([]byte, error) {
	spec := plannedXFOILScreeningSpec(runID, attemptID, plan, point, deflection)
	if err := validateXFOILSpec(spec); err != nil {
		return nil, err
	}
	return canonicalJSON(spec)
}

// RunXFOILScreeningCell executes one core-materialized cell and exposes only
// the immutable receipt id to orchestration. Full numerical output remains in
// the existing engineering job/CAS boundary.
func (service *Service) RunXFOILScreeningCell(
	ctx context.Context,
	runID, attemptID string,
	plan core.XFOILScreeningPlan,
	point core.XFOILOperatingPoint,
	deflection float64,
) (string, error) {
	result, err := service.XFOILPolar(ctx, plannedXFOILScreeningSpec(runID, attemptID, plan, point, deflection))
	if err != nil {
		return "", err
	}
	return result.ReceiptArtifactID, nil
}

func plannedXFOILScreeningSpec(
	runID, attemptID string,
	plan core.XFOILScreeningPlan,
	point core.XFOILOperatingPoint,
	deflection float64,
) XFOILSpec {
	flapChord := plan.FlapChordRatio
	hingeX := plan.FlapHingeXOverC
	hingeY := plan.FlapHingeYOverC
	flapDeflection := deflection
	ncrit := point.NCrit
	iterations := plan.Iterations
	panelCount := plan.PanelCount
	targetCL := point.TargetCL
	minimumCM := point.MinimumCM
	return XFOILSpec{
		RunID: runID, StageAttemptID: attemptID, NACA: plan.NACA,
		Reynolds: point.Reynolds, Mach: point.Mach,
		AlphaStartDeg: plan.AlphaStartDeg, AlphaEndDeg: plan.AlphaEndDeg, AlphaStepDeg: plan.AlphaStepDeg,
		ExecutionPurpose: XFOILPurposeScreening, OptimizationObjective: plan.OptimizationObjective,
		TargetCL: &targetCL, MinimumCM: &minimumCM,
		FlapChordRatio: &flapChord, FlapHingeXOverC: &hingeX, FlapHingeYOverC: &hingeY,
		FlapDeflectionDeg: &flapDeflection, NCrit: &ncrit, Iterations: &iterations, PanelCount: &panelCount,
	}
}

func (service *Service) SU2NACA0012(ctx context.Context, spec SU2Spec) (JobResult, error) {
	if err := validateSU2Spec(spec); err != nil {
		return JobResult{}, err
	}
	if _, err := RequireNativeSU2Host(); err != nil {
		return JobResult{}, err
	}
	return service.execute(ctx, spec.RunID, spec.StageAttemptID, "su2_naca0012",
		"su2", managedruntime.PinnedSU2Version, spec,
		func(parent context.Context, directory string) (operationOutput, error) {
			geoPath := filepath.Join(directory, "naca0012.geo")
			meshPath := filepath.Join(directory, "naca0012.su2")
			configPath := filepath.Join(directory, "case.cfg")
			if err := os.WriteFile(geoPath, []byte(naca0012Geo(spec.MeshSizeM)), 0o600); err != nil {
				return operationOutput{}, err
			}
			if err := os.WriteFile(configPath, []byte(su2Config(spec)), 0o600); err != nil {
				return operationOutput{}, err
			}
			operationCtx, cancel := context.WithTimeout(parent, 12*time.Minute)
			defer cancel()
			gmshArgs := []string{geoPath, "-2", "-nt", strconv.Itoa(service.threads), "-format", "su2", "-o", meshPath}
			gmshInfo, err := executableInfo("gmsh", managedruntime.PinnedGmshVersion,
				service.runtime.GmshExecutable, gmshArgs)
			if err != nil {
				return operationOutput{}, err
			}
			meshProcess, err := service.runCommand(operationCtx, directory,
				service.runtime.GmshExecutable, "", nil, gmshArgs...)
			if err != nil {
				return operationOutput{}, err
			}
			su2Args := []string{configPath}
			su2Info, err := executableInfo("su2", managedruntime.PinnedSU2Version,
				service.runtime.SU2CFDExecutable, su2Args)
			if err != nil {
				return operationOutput{}, err
			}
			environment := []string{
				"OMP_NUM_THREADS=" + strconv.Itoa(service.threads),
				"OMP_DYNAMIC=FALSE",
			}
			solverProcess, err := service.runCommand(operationCtx, directory,
				service.runtime.SU2CFDExecutable, "", environment, su2Args...)
			logPath := filepath.Join(directory, "su2.log")
			combined := processResult{
				stdout: "GMSH\n" + meshProcess.stdout + "\nSU2\n" + solverProcess.stdout,
				stderr: "GMSH\n" + meshProcess.stderr + "\nSU2\n" + solverProcess.stderr,
			}
			if writeErr := writeLog(logPath, combined); writeErr != nil {
				return operationOutput{}, errors.Join(err, writeErr)
			}
			if err != nil {
				return operationOutput{}, err
			}
			if regexp.MustCompile(`(?im)^\s*Error(?:\s+in\b|\s*:)`).MatchString(solverProcess.stdout + "\n" + solverProcess.stderr) {
				return operationOutput{}, errors.New("SU2 emitted an error marker")
			}
			solverLog := solverProcess.stdout + "\n" + solverProcess.stderr
			if strings.Contains(solverLog, "Maximum number of iterations reached") ||
				!strings.Contains(solverLog, "All convergence criteria satisfied.") {
				return operationOutput{}, errors.New("SU2 reached its iteration limit before satisfying the convergence criteria")
			}
			historyPath := filepath.Join(directory, "history.csv")
			metrics, err := parseSU2History(historyPath)
			if err != nil {
				return operationOutput{}, err
			}
			for _, source := range []struct {
				name string
				load func() (map[string]any, error)
			}{
				{"mesh", func() (map[string]any, error) { return parseSU2MeshMetrics(meshPath) }},
				{"log", func() (map[string]any, error) { return parseSU2LogMetrics(logPath) }},
				{"surface", func() (map[string]any, error) {
					return parseSU2SurfaceMetrics(filepath.Join(directory, "surface_flow.csv"), spec)
				}},
			} {
				values, analysisErr := source.load()
				if analysisErr != nil {
					return operationOutput{}, fmt.Errorf("analyze SU2 %s: %w", source.name, analysisErr)
				}
				if analysisErr := mergeSU2Metrics(metrics, values); analysisErr != nil {
					return operationOutput{}, analysisErr
				}
			}
			for key, value := range map[string]any{
				"solver": "EULER", "conv_num_method_flow": "JST", "cfl_number": 1000.0,
				"conv_residual_minval": -8.0, "farfield_x_min_chords": -10.0,
				"farfield_x_max_chords": 15.0, "farfield_y_abs_chords": 10.0,
			} {
				metrics[key] = value
			}
			files := []outputFile{
				{geoPath, "mesh_input", "naca0012.geo", "text/plain"},
				{meshPath, "mesh", "naca0012.su2", "application/vnd.su2.mesh"},
				{configPath, "config", "case.cfg", "text/plain"},
				{historyPath, "history", "history.csv", "text/csv"},
				{logPath, "log", "su2.log", "text/plain"},
			}
			for _, candidate := range []struct{ path, role, name, media string }{
				{filepath.Join(directory, "surface_flow.csv"), "surface", "surface_flow.csv", "text/csv"},
				{filepath.Join(directory, "restart_flow.dat"), "restart", "restart_flow.dat", "application/octet-stream"},
			} {
				if info, statErr := os.Stat(candidate.path); statErr == nil && info.Size() > 0 {
					files = append(files, outputFile{candidate.path, candidate.role, candidate.name, candidate.media})
				}
			}
			return operationOutput{
				metrics: metrics, files: files,
				executables: []executableReceipt{gmshInfo, su2Info},
				exitCodes:   []int{meshProcess.exitCode, solverProcess.exitCode}, numericallyValid: true,
			}, nil
		})
}

func validateWingSpec(spec WingSpec) error {
	if spec.RunID == "" || spec.StageAttemptID == "" || !finite(spec.SemiSpanM, spec.RootChordM,
		spec.TaperRatio, spec.SweepDeg, spec.Mach, spec.AlphaStartDeg, spec.AlphaEndDeg) {
		return errors.New("wing analysis identifiers and finite inputs are required")
	}
	if spec.SemiSpanM < .25 || spec.SemiSpanM > 100 || spec.RootChordM < .1 || spec.RootChordM > 25 ||
		spec.TaperRatio < .1 || spec.TaperRatio > 1 || spec.SweepDeg < -20 || spec.SweepDeg > 65 ||
		spec.Mach <= 0 || spec.Mach > .75 || spec.AlphaStartDeg < -15 || spec.AlphaEndDeg > 25 ||
		spec.AlphaEndDeg < spec.AlphaStartDeg || spec.AlphaPoints < 1 || spec.AlphaPoints > 21 {
		return errors.New("wing analysis inputs are outside the supported aerodynamic envelope")
	}
	return nil
}

func validateMeshSpec(spec MeshSpec) error {
	wing := WingSpec{RunID: spec.RunID, StageAttemptID: spec.StageAttemptID, SemiSpanM: spec.SemiSpanM,
		RootChordM: spec.RootChordM, TaperRatio: spec.TaperRatio, SweepDeg: spec.SweepDeg,
		Mach: .1, AlphaStartDeg: 0, AlphaEndDeg: 0, AlphaPoints: 1}
	if err := validateWingSpec(wing); err != nil {
		return err
	}
	if !finite(spec.MeshSizeM) || spec.MeshSizeM <= 0 || spec.MeshSizeM > spec.RootChordM/2 {
		return errors.New("mesh_size_m must be positive and no larger than half the root chord")
	}
	return nil
}

func validateXFOILSpec(spec XFOILSpec) error {
	_, err := normalizedXFOILSettings(spec)
	return err
}

func normalizedXFOILSettings(spec XFOILSpec) (xfoilSettings, error) {
	if spec.RunID == "" || spec.StageAttemptID == "" || !nacaPattern.MatchString(spec.NACA) ||
		!finite(spec.Reynolds, spec.Mach, spec.AlphaStartDeg, spec.AlphaEndDeg, spec.AlphaStepDeg) {
		return xfoilSettings{}, errors.New("XFOIL identifiers, NACA 4-digit code, and finite inputs are required")
	}
	if spec.Reynolds < 5e4 || spec.Reynolds > 5e7 || spec.Mach < 0 || spec.Mach > .7 ||
		spec.AlphaStartDeg < -15 || spec.AlphaEndDeg > 20 || spec.AlphaEndDeg <= spec.AlphaStartDeg ||
		spec.AlphaStepDeg < .01 || spec.AlphaStepDeg > 5 {
		return xfoilSettings{}, errors.New("XFOIL inputs are outside the supported polar envelope")
	}
	switch spec.ExecutionPurpose {
	case "":
		if strings.TrimSpace(spec.VerificationOfJobID) != "" {
			return xfoilSettings{}, errors.New("verification_of_job_id is only valid for independent_verification")
		}
		if spec.OptimizationObjective != "" || spec.TargetCL != nil || spec.MinimumCM != nil {
			return xfoilSettings{}, errors.New("legacy XFOIL requests must omit the optimization contract")
		}
	case XFOILPurposeScreening:
		if strings.TrimSpace(spec.VerificationOfJobID) != "" {
			return xfoilSettings{}, errors.New("verification_of_job_id is only valid for independent_verification")
		}
		if err := validateXFOILOptimizationContract(spec); err != nil {
			return xfoilSettings{}, err
		}
	case XFOILPurposeIndependentVerification:
		if strings.TrimSpace(spec.VerificationOfJobID) == "" {
			return xfoilSettings{}, errors.New("independent_verification requires verification_of_job_id")
		}
		if err := validateXFOILOptimizationContract(spec); err != nil {
			return xfoilSettings{}, err
		}
	default:
		return xfoilSettings{}, errors.New("unsupported XFOIL execution_purpose")
	}
	grid, err := xfoilAlphaGrid(spec.AlphaStartDeg, spec.AlphaEndDeg, spec.AlphaStepDeg)
	if err != nil {
		return xfoilSettings{}, err
	}
	settings := xfoilSettings{NCrit: 9, Iterations: 250, PanelCount: 160, AlphaGrid: grid}
	if spec.NCrit != nil {
		settings.NCrit = *spec.NCrit
	}
	if spec.Iterations != nil {
		settings.Iterations = *spec.Iterations
	}
	if spec.PanelCount != nil {
		settings.PanelCount = *spec.PanelCount
	}
	if !finite(settings.NCrit) || settings.NCrit < 1 || settings.NCrit > 14 ||
		settings.Iterations < 50 || settings.Iterations > 500 ||
		settings.PanelCount < 80 || settings.PanelCount > 300 {
		return xfoilSettings{}, errors.New("XFOIL Ncrit, iteration, or panel settings are outside the supported envelope")
	}

	flapFields := 0
	for _, present := range []bool{
		spec.FlapChordRatio != nil, spec.FlapHingeXOverC != nil,
		spec.FlapHingeYOverC != nil, spec.FlapDeflectionDeg != nil,
	} {
		if present {
			flapFields++
		}
	}
	if flapFields != 0 && flapFields != 4 {
		return xfoilSettings{}, errors.New("sealed plain-flap chord, hinge x/y, and deflection fields must be supplied together")
	}
	if flapFields == 4 {
		flap := xfoilFlapSettings{
			ChordRatio: *spec.FlapChordRatio, HingeXOverC: *spec.FlapHingeXOverC,
			HingeYOverC: *spec.FlapHingeYOverC, DeflectionDeg: *spec.FlapDeflectionDeg,
		}
		if !finite(flap.ChordRatio, flap.HingeXOverC, flap.HingeYOverC, flap.DeflectionDeg) ||
			flap.ChordRatio < .05 || flap.ChordRatio > .5 ||
			flap.HingeXOverC < .5 || flap.HingeXOverC > .95 ||
			flap.DeflectionDeg < -40 || flap.DeflectionDeg > 40 {
			return xfoilSettings{}, errors.New("sealed plain-flap inputs are outside the supported geometry envelope")
		}
		if math.Abs((1-flap.HingeXOverC)-flap.ChordRatio) > 1e-8 {
			return xfoilSettings{}, errors.New("flap_chord_ratio must equal 1 - flap_hinge_x_over_c")
		}
		lower, upper, envelopeErr := nacaFourDigitEnvelope(spec.NACA, flap.HingeXOverC)
		if envelopeErr != nil {
			return xfoilSettings{}, envelopeErr
		}
		if flap.HingeYOverC <= lower+1e-6 || flap.HingeYOverC >= upper-1e-6 {
			return xfoilSettings{}, errors.New("sealed plain-flap hinge y/c must lie strictly inside the base airfoil")
		}
		settings.Flap = &flap
	}
	if spec.ExecutionPurpose != "" && settings.Flap == nil {
		return xfoilSettings{}, errors.New("XFOIL optimization requires an explicit sealed plain-flap candidate")
	}
	return settings, nil
}

func validateXFOILOptimizationContract(spec XFOILSpec) error {
	if spec.OptimizationObjective != XFOILObjectiveMinimizeCDAtTargetCL ||
		spec.TargetCL == nil || spec.MinimumCM == nil {
		return errors.New("XFOIL screening and independent verification require minimize_cd_at_target_cl, target_cl, and minimum_cm")
	}
	if !finite(*spec.TargetCL, *spec.MinimumCM) || *spec.TargetCL < -5 || *spec.TargetCL > 5 ||
		*spec.MinimumCM < -5 || *spec.MinimumCM > 5 {
		return errors.New("XFOIL optimization target_cl or minimum_cm is outside the supported envelope")
	}
	return nil
}

type xfoilSpecEnvelope struct {
	Arguments json.RawMessage `json:"arguments"`
	Operation string          `json:"operation"`
	Runtime   string          `json:"runtime_bundle_hash"`
	Component string          `json:"tool_component"`
	Version   string          `json:"tool_version"`
}

type xfoilTargetMetrics struct {
	AlphaDeg            float64                 `json:"alpha_deg"`
	CL                  float64                 `json:"cl"`
	CD                  float64                 `json:"cd"`
	CM                  float64                 `json:"cm_c4"`
	FlapDeflectionDeg   float64                 `json:"flap_deflection_deg"`
	ConstraintSatisfied bool                    `json:"constraint_satisfied"`
	Interpolation       xfoilInterpolationTrace `json:"interpolation"`
}

// xfoilInterpolationTrace makes every reported target-CL value reproducible.
// Fraction is the weight of Right; exact sample hits use identical endpoints.
type xfoilInterpolationTrace struct {
	Left           XFOILSample `json:"left"`
	Right          XFOILSample `json:"right"`
	LeftIndex      int         `json:"left_index"`
	RightIndex     int         `json:"right_index"`
	LeftValueHash  string      `json:"left_value_hash"`
	RightValueHash string      `json:"right_value_hash"`
	Fraction       float64     `json:"right_weight"`
}

type xfoilSweepCandidate struct {
	JobID             string              `json:"job_id"`
	StageAttemptID    string              `json:"stage_attempt_id"`
	ReceiptArtifactID string              `json:"receipt_artifact_id"`
	ReceiptBlobHash   string              `json:"receipt_blob_hash"`
	FlapDeflectionDeg float64             `json:"flap_deflection_deg"`
	TargetReached     bool                `json:"target_reached"`
	Target            *xfoilTargetMetrics `json:"target_metrics"`
	Samples           []XFOILSample       `json:"-"`
}

type xfoilVerificationContract struct {
	WinnerJob               store.EngineeringJob
	WinnerSpec              XFOILSpec
	WinnerTarget            xfoilTargetMetrics
	ScreeningAttemptCount   int
	ScreeningCandidateCount int
	SucceededAttemptCount   int
	FailedAttemptCount      int
	Candidates              []xfoilSweepCandidate
}

func (service *Service) validateIndependentXFOIL(
	ctx context.Context, spec XFOILSpec,
) (*xfoilVerificationContract, error) {
	projectID, err := service.db.ValidateEngineeringCapability(ctx, spec.RunID, spec.StageAttemptID)
	if err != nil {
		return nil, err
	}
	var stage string
	var ordinal int
	if err := service.db.SQL().QueryRowContext(ctx,
		"SELECT stage, logical_ordinal FROM stage_attempts WHERE id=? AND run_id=?",
		spec.StageAttemptID, spec.RunID,
	).Scan(&stage, &ordinal); err != nil {
		return nil, err
	}
	if stage != string(core.StageCollect) || ordinal != core.EngineeringVerificationOrdinal {
		return nil, errors.New("independent XFOIL verification requires the reserved verification collect attempt")
	}
	contract, err := service.recomputeXFOILSweep(ctx, spec.RunID, projectID)
	if err != nil {
		return nil, err
	}
	if spec.VerificationOfJobID != contract.WinnerJob.ID {
		return nil, fmt.Errorf("verification_of_job_id %s is not the deterministic sweep winner %s",
			spec.VerificationOfJobID, contract.WinnerJob.ID)
	}
	if err := ValidateIndependentXFOILContract(contract.WinnerSpec, spec, contract.WinnerTarget.AlphaDeg); err != nil {
		return nil, fmt.Errorf("independent XFOIL verification contract: %w", err)
	}
	return &contract, nil
}

func (service *Service) recomputeXFOILSweep(
	ctx context.Context, runID, projectID string,
) (xfoilVerificationContract, error) {
	jobs, err := service.db.ListRunEngineeringJobs(ctx, runID, "xfoil_polar")
	if err != nil {
		return xfoilVerificationContract{}, err
	}
	runtimeHash, err := service.runtimeIdentity("xfoil")
	if err != nil {
		return xfoilVerificationContract{}, err
	}
	type successfulCandidate struct {
		job    store.EngineeringJob
		spec   XFOILSpec
		target xfoilTargetMetrics
	}
	contract := xfoilVerificationContract{}
	var sweepIdentity []byte
	candidateAttempts := make(map[uint64]int)
	succeededCandidates := make(map[uint64]successfulCandidate)
	for _, job := range jobs {
		envelope, candidateSpec, err := decodeXFOILJobSpec(job)
		if err != nil {
			return xfoilVerificationContract{}, err
		}
		if candidateSpec.ExecutionPurpose != XFOILPurposeScreening {
			continue
		}
		if job.RunID != runID || job.ProjectID != projectID || job.StageAttemptID != candidateSpec.StageAttemptID ||
			candidateSpec.RunID != runID || job.ToolComponent != "xfoil" ||
			job.ToolVersion != managedruntime.PinnedXFOILVersion || envelope.Runtime != runtimeHash {
			return xfoilVerificationContract{}, errors.New("screening XFOIL job is not bound to the active run, project, stage, and runtime")
		}
		if err := validateXFOILSpec(candidateSpec); err != nil {
			return xfoilVerificationContract{}, fmt.Errorf("screening XFOIL job %s has invalid arguments: %w", job.ID, err)
		}
		var candidateStage string
		var candidateOrdinal int
		if err := service.db.SQL().QueryRowContext(ctx,
			"SELECT stage, logical_ordinal FROM stage_attempts WHERE id=? AND run_id=?",
			job.StageAttemptID, runID,
		).Scan(&candidateStage, &candidateOrdinal); err != nil {
			return xfoilVerificationContract{}, err
		}
		if candidateStage != string(core.StageCollect) || candidateOrdinal < 0 ||
			candidateOrdinal >= core.EngineeringVerificationOrdinal {
			return xfoilVerificationContract{}, errors.New("screening XFOIL jobs must belong to ordinary collector attempts")
		}
		identity, err := xfoilSweepIdentity(candidateSpec)
		if err != nil {
			return xfoilVerificationContract{}, err
		}
		if sweepIdentity == nil {
			sweepIdentity = identity
		} else if !bytes.Equal(sweepIdentity, identity) {
			return xfoilVerificationContract{}, errors.New("XFOIL screening jobs do not form one homogeneous flap-deflection sweep")
		}
		deflection := *candidateSpec.FlapDeflectionDeg
		if deflection == 0 {
			deflection = 0 // Collapse negative zero into the same sweep candidate.
		}
		candidateKey := math.Float64bits(deflection)
		candidateAttempts[candidateKey]++
		contract.ScreeningAttemptCount++
		switch job.Status {
		case "failed":
			contract.FailedAttemptCount++
		case "succeeded":
			if _, duplicate := succeededCandidates[candidateKey]; duplicate {
				return xfoilVerificationContract{}, errors.New("XFOIL sweep contains duplicate succeeded jobs for one flap deflection")
			}
			readback, err := service.readCompleted(ctx, job)
			if err != nil {
				return xfoilVerificationContract{}, fmt.Errorf("CAS-verify screening receipt %s: %w", job.ID, err)
			}
			samples, err := xfoilSamplesFromResult(readback)
			if err != nil {
				return xfoilVerificationContract{}, fmt.Errorf("screening receipt %s target data: %w", job.ID, err)
			}
			_, target, err := xfoilOptimizationMetrics(candidateSpec, samples)
			if err != nil {
				return xfoilVerificationContract{}, fmt.Errorf("screening receipt %s interpolation: %w", job.ID, err)
			}
			contract.SucceededAttemptCount++
			contract.Candidates = append(contract.Candidates, xfoilSweepCandidate{
				JobID: job.ID, StageAttemptID: job.StageAttemptID,
				ReceiptArtifactID: readback.ReceiptArtifactID, ReceiptBlobHash: readback.Provenance.BlobHash,
				FlapDeflectionDeg: deflection, TargetReached: target != nil, Target: target,
				Samples: append([]XFOILSample(nil), samples...),
			})
			if target != nil && target.ConstraintSatisfied {
				succeededCandidates[candidateKey] = successfulCandidate{job: job, spec: candidateSpec, target: *target}
			} else {
				// Preserve a marker so a second succeeded job for the same candidate
				// is still rejected even when the first one is infeasible.
				succeededCandidates[candidateKey] = successfulCandidate{job: job, spec: candidateSpec}
			}
		default:
			return xfoilVerificationContract{}, fmt.Errorf("screening XFOIL job %s is still %s", job.ID, job.Status)
		}
	}
	contract.ScreeningCandidateCount = len(candidateAttempts)
	if contract.ScreeningAttemptCount < 2 || contract.ScreeningCandidateCount < 2 || contract.SucceededAttemptCount < 2 {
		return xfoilVerificationContract{}, errors.New("independent XFOIL verification requires at least two completed screening candidates")
	}
	winnerFound := false
	for _, candidate := range succeededCandidates {
		if !candidate.target.ConstraintSatisfied {
			continue
		}
		if !winnerFound || xfoilTargetWins(candidate.target, candidate.job.ID, contract.WinnerTarget, contract.WinnerJob.ID) {
			contract.WinnerJob = candidate.job
			contract.WinnerSpec = candidate.spec
			contract.WinnerTarget = candidate.target
			winnerFound = true
		}
	}
	if !winnerFound {
		return xfoilVerificationContract{}, errors.New("XFOIL screening sweep has no candidate satisfying target CL and minimum CM")
	}
	slices.SortFunc(contract.Candidates, func(left, right xfoilSweepCandidate) int {
		if left.FlapDeflectionDeg < right.FlapDeflectionDeg {
			return -1
		}
		if left.FlapDeflectionDeg > right.FlapDeflectionDeg {
			return 1
		}
		return strings.Compare(left.JobID, right.JobID)
	})
	return contract, nil
}

func decodeXFOILJobSpec(job store.EngineeringJob) (xfoilSpecEnvelope, XFOILSpec, error) {
	if job.Operation != "xfoil_polar" || job.SpecJSON == "" || job.SpecSHA256 == "" {
		return xfoilSpecEnvelope{}, XFOILSpec{}, errors.New("XFOIL engineering job specification is incomplete")
	}
	digest := sha256.Sum256([]byte(job.SpecJSON))
	if hex.EncodeToString(digest[:]) != job.SpecSHA256 {
		return xfoilSpecEnvelope{}, XFOILSpec{}, fmt.Errorf("XFOIL engineering job %s specification hash is invalid", job.ID)
	}
	var envelope xfoilSpecEnvelope
	if err := json.Unmarshal([]byte(job.SpecJSON), &envelope); err != nil || len(envelope.Arguments) == 0 {
		return xfoilSpecEnvelope{}, XFOILSpec{}, fmt.Errorf("XFOIL engineering job %s specification is invalid", job.ID)
	}
	if envelope.Operation != "xfoil_polar" || envelope.Component != "xfoil" ||
		envelope.Version != managedruntime.PinnedXFOILVersion || envelope.Runtime == "" {
		return xfoilSpecEnvelope{}, XFOILSpec{}, fmt.Errorf("XFOIL engineering job %s tool binding is invalid", job.ID)
	}
	var spec XFOILSpec
	if err := json.Unmarshal(envelope.Arguments, &spec); err != nil {
		return xfoilSpecEnvelope{}, XFOILSpec{}, fmt.Errorf("XFOIL engineering job %s arguments are invalid", job.ID)
	}
	return envelope, spec, nil
}

func xfoilSweepIdentity(spec XFOILSpec) ([]byte, error) {
	if err := normalizeXFOILIdentityDefaults(&spec); err != nil {
		return nil, err
	}
	spec.RunID = ""
	spec.StageAttemptID = ""
	spec.ExecutionPurpose = ""
	spec.VerificationOfJobID = ""
	spec.FlapDeflectionDeg = nil
	return canonicalJSON(spec)
}

func xfoilPhysicalIdentity(spec XFOILSpec) ([]byte, error) {
	if err := normalizeXFOILIdentityDefaults(&spec); err != nil {
		return nil, err
	}
	spec.RunID = ""
	spec.StageAttemptID = ""
	spec.ExecutionPurpose = ""
	spec.VerificationOfJobID = ""
	return canonicalJSON(spec)
}

func normalizeXFOILIdentityDefaults(spec *XFOILSpec) error {
	settings, err := normalizedXFOILSettings(*spec)
	if err != nil {
		return err
	}
	ncrit, iterations, panelCount := settings.NCrit, settings.Iterations, settings.PanelCount
	spec.NCrit, spec.Iterations, spec.PanelCount = &ncrit, &iterations, &panelCount
	if spec.FlapDeflectionDeg != nil && *spec.FlapDeflectionDeg == 0 {
		zero := 0.0
		spec.FlapDeflectionDeg = &zero
	}
	return nil
}

func xfoilSamplesFromResult(result JobResult) ([]XFOILSample, error) {
	value, ok := result.Metrics["samples"]
	if !ok {
		return nil, errors.New("XFOIL receipt has no samples")
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var samples []XFOILSample
	if err := json.Unmarshal(encoded, &samples); err != nil || len(samples) < 2 {
		return nil, errors.New("XFOIL receipt samples are invalid")
	}
	return samples, nil
}

func xfoilOptimizationMetrics(
	spec XFOILSpec, samples []XFOILSample,
) (map[string]any, *xfoilTargetMetrics, error) {
	if err := validateXFOILOptimizationContract(spec); err != nil {
		return nil, nil, err
	}
	target, found, err := interpolateXFOILTarget(samples, *spec.TargetCL)
	if err != nil {
		return nil, nil, err
	}
	metric := map[string]any{
		"objective":      spec.OptimizationObjective,
		"target_cl":      *spec.TargetCL,
		"minimum_cm":     *spec.MinimumCM,
		"target_reached": found,
	}
	if !found {
		return metric, nil, nil
	}
	target.FlapDeflectionDeg = *spec.FlapDeflectionDeg
	target.ConstraintSatisfied = target.CM >= *spec.MinimumCM
	metric["target_metrics"] = target
	return metric, &target, nil
}

func xfoilSampleHash(sample XFOILSample) string {
	encoded, _ := json.Marshal(sample)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func interpolateXFOILTarget(samples []XFOILSample, targetCL float64) (xfoilTargetMetrics, bool, error) {
	if len(samples) < 2 || !finite(targetCL) {
		return xfoilTargetMetrics{}, false, errors.New("XFOIL target interpolation requires finite target CL and at least two samples")
	}
	for index, sample := range samples {
		if !finite(sample.Alpha, sample.CL, sample.CD, sample.CM) || sample.CD <= 0 {
			return xfoilTargetMetrics{}, false, errors.New("XFOIL target interpolation received invalid polar coefficients")
		}
		if index > 0 && sample.Alpha <= samples[index-1].Alpha {
			return xfoilTargetMetrics{}, false, errors.New("XFOIL target interpolation requires strictly increasing alpha samples")
		}
	}
	candidates := make([]xfoilTargetMetrics, 0, 2)
	const exactTolerance = 1e-12
	for index, sample := range samples {
		if math.Abs(sample.CL-targetCL) <= exactTolerance {
			candidates = append(candidates, xfoilTargetMetrics{
				AlphaDeg: sample.Alpha, CL: targetCL, CD: sample.CD, CM: sample.CM,
				Interpolation: xfoilInterpolationTrace{
					Left: sample, Right: sample, LeftIndex: index, RightIndex: index,
					LeftValueHash: xfoilSampleHash(sample), RightValueHash: xfoilSampleHash(sample),
				},
			})
		}
	}
	for index := 0; index+1 < len(samples); index++ {
		left, right := samples[index], samples[index+1]
		leftDelta, rightDelta := left.CL-targetCL, right.CL-targetCL
		if math.Abs(leftDelta) <= exactTolerance || math.Abs(rightDelta) <= exactTolerance ||
			leftDelta*rightDelta >= 0 {
			continue
		}
		fraction := (targetCL - left.CL) / (right.CL - left.CL)
		point := xfoilTargetMetrics{
			AlphaDeg: left.Alpha + fraction*(right.Alpha-left.Alpha),
			CL:       targetCL,
			CD:       left.CD + fraction*(right.CD-left.CD),
			CM:       left.CM + fraction*(right.CM-left.CM),
			Interpolation: xfoilInterpolationTrace{
				Left: left, Right: right, LeftIndex: index, RightIndex: index + 1,
				LeftValueHash: xfoilSampleHash(left), RightValueHash: xfoilSampleHash(right),
				Fraction: fraction,
			},
		}
		if !finite(point.AlphaDeg, point.CD, point.CM) || point.CD <= 0 {
			return xfoilTargetMetrics{}, false, errors.New("XFOIL target interpolation produced invalid coefficients")
		}
		candidates = append(candidates, point)
	}
	if len(candidates) == 0 {
		return xfoilTargetMetrics{}, false, nil
	}
	best := candidates[0]
	for _, candidate := range candidates[1:] {
		if candidate.CD < best.CD-1e-12 ||
			(math.Abs(candidate.CD-best.CD) <= 1e-12 && candidate.AlphaDeg < best.AlphaDeg) {
			best = candidate
		}
	}
	return best, true, nil
}

type xfoilGraphSeries struct {
	Label           string        `json:"label"`
	JobID           string        `json:"job_id"`
	ReceiptBlobHash string        `json:"receipt_blob_hash,omitempty"`
	Samples         []XFOILSample `json:"samples"`
}

func writeXFOILVerificationDossier(
	directory string,
	contract xfoilVerificationContract,
	verificationSpec XFOILSpec,
	verificationTarget xfoilTargetMetrics,
	verificationSamples []XFOILSample,
) ([]outputFile, map[string]any, error) {
	workspaceID := filepath.Base(filepath.Clean(directory))
	workspacesDistinct := contract.WinnerJob.ID != workspaceID
	graphDataName := "optimization-graph-data.json"
	dossier := map[string]any{
		"schema":                            "xfoil_optimization_dossier_v1",
		"screening_attempt_count":           contract.ScreeningAttemptCount,
		"screening_candidate_count":         contract.ScreeningCandidateCount,
		"succeeded_screening_attempt_count": contract.SucceededAttemptCount,
		"failed_screening_attempt_count":    contract.FailedAttemptCount,
		"screening_panel_count":             contract.WinnerSpec.PanelCount,
		"verification_panel_count":          verificationSpec.PanelCount,
		"screening_candidates":              contract.Candidates,
		"winner_job_id":                     contract.WinnerJob.ID,
		"winner_target_metrics":             contract.WinnerTarget,
		"figures": []map[string]string{
			{"kind": "cl_alpha", "data_file": graphDataName, "render_file": "comparison-cl-alpha.svg"},
			{"kind": "cl_cd", "data_file": graphDataName, "render_file": "comparison-cl-cd.svg"},
			{"kind": "cm_cl", "data_file": graphDataName, "render_file": "comparison-cm-cl.svg"},
		},
		"verification": map[string]any{
			"workspace_id":              workspaceID,
			"screening_workspace_id":    contract.WinnerJob.ID,
			"verification_workspace_id": workspaceID,
			"workspaces_distinct":       workspacesDistinct,
			"stage_attempt_id":          verificationSpec.StageAttemptID,
			"verification_of_job_id":    verificationSpec.VerificationOfJobID,
			"attempt_count":             1,
			"process_spawn_count":       1,
			"execution_count":           1,
			"retry_count":               0,
			"isolated_workspace":        true,
			"target_metrics":            verificationTarget,
		},
	}
	encoded, err := json.MarshalIndent(dossier, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("encode XFOIL optimization dossier: %w", err)
	}
	dossierPath := filepath.Join(directory, "optimization-dossier.json")
	if err := os.WriteFile(dossierPath, append(encoded, '\n'), 0o600); err != nil {
		return nil, nil, fmt.Errorf("write XFOIL optimization dossier: %w", err)
	}
	series := make([]xfoilGraphSeries, 0, len(contract.Candidates)+1)
	for _, candidate := range contract.Candidates {
		series = append(series, xfoilGraphSeries{
			Label: fmt.Sprintf("%.6g deg", candidate.FlapDeflectionDeg),
			JobID: candidate.JobID, ReceiptBlobHash: candidate.ReceiptBlobHash,
			Samples: candidate.Samples,
		})
	}
	series = append(series, xfoilGraphSeries{
		Label: "verification", JobID: workspaceID, Samples: verificationSamples,
	})
	graphData := map[string]any{"schema": "xfoil_graph_data_v1", "series": series}
	graphDataBytes, err := json.MarshalIndent(graphData, "", "  ")
	if err != nil {
		return nil, nil, fmt.Errorf("encode XFOIL graph data: %w", err)
	}
	graphDataPath := filepath.Join(directory, graphDataName)
	if err := os.WriteFile(graphDataPath, append(graphDataBytes, '\n'), 0o600); err != nil {
		return nil, nil, fmt.Errorf("write XFOIL graph data: %w", err)
	}
	charts := []struct {
		name, role, title, xLabel, yLabel string
		x, y                              func(XFOILSample) float64
	}{
		{"comparison-cl-alpha.svg", "graph_cl_alpha", "CL-alpha", "alpha (deg)", "CL", func(s XFOILSample) float64 { return s.Alpha }, func(s XFOILSample) float64 { return s.CL }},
		{"comparison-cl-cd.svg", "graph_cl_cd", "CL-CD", "CD", "CL", func(s XFOILSample) float64 { return s.CD }, func(s XFOILSample) float64 { return s.CL }},
		{"comparison-cm-cl.svg", "graph_cm_cl", "Cm-CL", "CL", "Cm(c/4)", func(s XFOILSample) float64 { return s.CL }, func(s XFOILSample) float64 { return s.CM }},
	}
	files := []outputFile{
		{dossierPath, "optimization_dossier", "optimization-dossier.json", "application/json"},
		{graphDataPath, "graph_data", graphDataName, "application/json"},
	}
	for _, chart := range charts {
		path := filepath.Join(directory, chart.name)
		if err := writeXFOILComparisonSVG(path, chart.title, chart.xLabel, chart.yLabel, series, chart.x, chart.y); err != nil {
			return nil, nil, err
		}
		files = append(files, outputFile{path, chart.role, chart.name, "image/svg+xml"})
	}
	return files, dossier, nil
}

func writeXFOILComparisonSVG(
	path, title, xLabel, yLabel string,
	series []xfoilGraphSeries,
	xValue, yValue func(XFOILSample) float64,
) error {
	const width, height = 960.0, 560.0
	const left, right, top, bottom = 80.0, 210.0, 55.0, 65.0
	minX, maxX, minY, maxY := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	for _, item := range series {
		for _, sample := range item.Samples {
			x, y := xValue(sample), yValue(sample)
			if !finite(x, y) {
				continue
			}
			minX, maxX = math.Min(minX, x), math.Max(maxX, x)
			minY, maxY = math.Min(minY, y), math.Max(maxY, y)
		}
	}
	if !finite(minX, maxX, minY, maxY) {
		return errors.New("XFOIL comparison graph has no finite points")
	}
	if maxX == minX {
		maxX, minX = maxX+0.5, minX-0.5
	}
	if maxY == minY {
		maxY, minY = maxY+0.5, minY-0.5
	}
	plotW, plotH := width-left-right, height-top-bottom
	sx := func(value float64) float64 { return left + (value-minX)/(maxX-minX)*plotW }
	sy := func(value float64) float64 { return top + (maxY-value)/(maxY-minY)*plotH }
	colors := []string{"#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#a78bfa", "#2dd4bf", "#f97316", "#e879f9", "#f8fafc"}
	var out strings.Builder
	fmt.Fprintf(&out, `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="560" viewBox="0 0 960 560"><rect width="960" height="560" fill="#0b1220"/><g fill="none" stroke="#64748b" stroke-width="1"><path d="M80 55V495H750"/></g><g fill="#e2e8f0" font-family="Segoe UI,Arial,sans-serif"><text x="80" y="32" font-size="22">%s</text><text x="390" y="545" font-size="14">%s</text><text x="14" y="275" font-size="14" transform="rotate(-90 14 275)">%s</text><text x="80" y="520" font-size="12">%.6g</text><text x="700" y="520" font-size="12">%.6g</text><text x="28" y="495" font-size="12">%.6g</text><text x="28" y="65" font-size="12">%.6g</text></g>`, title, xLabel, yLabel, minX, maxX, minY, maxY)
	for index, item := range series {
		color := colors[index%len(colors)]
		out.WriteString(`<polyline fill="none" stroke="` + color + `" stroke-width="1.6" points="`)
		for _, sample := range item.Samples {
			x, y := xValue(sample), yValue(sample)
			if finite(x, y) {
				fmt.Fprintf(&out, "%.2f,%.2f ", sx(x), sy(y))
			}
		}
		fmt.Fprintf(&out, `"/><g fill="%s" font-family="Segoe UI,Arial,sans-serif" font-size="12"><rect x="770" y="%d" width="14" height="3"/><text x="792" y="%d">%s</text></g>`, color, 75+index*24, 80+index*24, item.Label)
	}
	out.WriteString(`</svg>`)
	if err := os.WriteFile(path, []byte(out.String()), 0o600); err != nil {
		return fmt.Errorf("write XFOIL comparison graph: %w", err)
	}
	return nil
}

func xfoilTargetWins(candidate xfoilTargetMetrics, candidateJobID string, incumbent xfoilTargetMetrics, incumbentJobID string) bool {
	if candidate.CD < incumbent.CD-1e-12 {
		return true
	}
	if math.Abs(candidate.CD-incumbent.CD) > 1e-12 {
		return false
	}
	if candidate.FlapDeflectionDeg < incumbent.FlapDeflectionDeg-1e-12 {
		return true
	}
	if math.Abs(candidate.FlapDeflectionDeg-incumbent.FlapDeflectionDeg) > 1e-12 {
		return false
	}
	return candidateJobID < incumbentJobID
}

func requireXFOILExactTargetAgreement(expected, actual xfoilTargetMetrics) error {
	closeEnough := func(left, right float64) bool {
		tolerance := 1e-8 * math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
		return math.Abs(left-right) <= tolerance
	}
	if !actual.ConstraintSatisfied || !closeEnough(expected.AlphaDeg, actual.AlphaDeg) ||
		!closeEnough(expected.CL, actual.CL) || !closeEnough(expected.CD, actual.CD) ||
		!closeEnough(expected.CM, actual.CM) ||
		!closeEnough(expected.FlapDeflectionDeg, actual.FlapDeflectionDeg) {
		return errors.New("independent XFOIL target metrics do not agree with the deterministic screening winner")
	}
	return nil
}

func requireXFOILIndependentTargetAgreement(expected, actual xfoilTargetMetrics) error {
	if !actual.ConstraintSatisfied ||
		math.Abs(expected.FlapDeflectionDeg-actual.FlapDeflectionDeg) > xfoilContractTolerance(expected.FlapDeflectionDeg) ||
		!XFOILIndependentTargetsAgree(expected.CL, expected.CD, expected.CM, actual.CL, actual.CD, actual.CM) {
		return fmt.Errorf("independent XFOIL target metrics exceed CD tolerance max(%.4g, %.0f%%) or CM tolerance %.4g",
			XFOILVerificationCDAbsoluteTolerance, XFOILVerificationCDRelativeTolerance*100, XFOILVerificationCMTolerance)
	}
	return nil
}

func (service *Service) validateIndependentXFOILReadback(
	ctx context.Context, spec XFOILSpec, result JobResult, expected xfoilVerificationContract,
) error {
	verificationJob, err := service.db.EngineeringJob(ctx, result.JobID)
	if err != nil {
		return err
	}
	if verificationJob.RunID != spec.RunID || verificationJob.ProjectID != expected.WinnerJob.ProjectID ||
		verificationJob.StageAttemptID != spec.StageAttemptID || verificationJob.Status != "succeeded" {
		return errors.New("independent XFOIL readback is not bound to the verification run and attempt")
	}
	verificationEnvelope, verificationSpec, err := decodeXFOILJobSpec(verificationJob)
	if err != nil {
		return err
	}
	sourceJob, err := service.db.EngineeringJob(ctx, expected.WinnerJob.ID)
	if err != nil {
		return err
	}
	sourceEnvelope, sourceSpec, err := decodeXFOILJobSpec(sourceJob)
	if err != nil {
		return err
	}
	if sourceJob.ToolComponent != verificationJob.ToolComponent || sourceJob.ToolVersion != verificationJob.ToolVersion ||
		sourceEnvelope.Runtime != verificationEnvelope.Runtime || sourceEnvelope.Component != verificationEnvelope.Component ||
		sourceEnvelope.Version != verificationEnvelope.Version {
		return errors.New("independent XFOIL source and verification tool/runtime bindings differ")
	}
	runtimeHash, err := service.runtimeIdentity("xfoil")
	if err != nil {
		return err
	}
	if verificationEnvelope.Runtime != runtimeHash || verificationEnvelope.Component != "xfoil" ||
		verificationEnvelope.Version != managedruntime.PinnedXFOILVersion ||
		verificationSpec.ExecutionPurpose != XFOILPurposeIndependentVerification ||
		verificationSpec.VerificationOfJobID != sourceJob.ID ||
		sourceSpec.ExecutionPurpose != XFOILPurposeScreening {
		return errors.New("independent XFOIL readback has an invalid source, purpose, or active runtime binding")
	}
	if err := ValidateIndependentXFOILContract(sourceSpec, verificationSpec, expected.WinnerTarget.AlphaDeg); err != nil {
		return fmt.Errorf("independent XFOIL readback contract: %w", err)
	}
	sourceReadback, err := service.readCompleted(ctx, sourceJob)
	if err != nil {
		return fmt.Errorf("CAS-verify deterministic winner: %w", err)
	}
	verificationReadback, err := service.readCompleted(ctx, verificationJob)
	if err != nil {
		return fmt.Errorf("CAS-verify independent verification: %w", err)
	}
	sourceSamples, err := xfoilSamplesFromResult(sourceReadback)
	if err != nil {
		return err
	}
	_, sourceTarget, err := xfoilOptimizationMetrics(sourceSpec, sourceSamples)
	if err != nil || sourceTarget == nil || !sourceTarget.ConstraintSatisfied {
		return errors.New("deterministic XFOIL winner no longer has a feasible target metric")
	}
	if err := requireXFOILExactTargetAgreement(expected.WinnerTarget, *sourceTarget); err != nil {
		return err
	}
	verificationSamples, err := xfoilSamplesFromResult(verificationReadback)
	if err != nil {
		return err
	}
	_, verificationTarget, err := xfoilOptimizationMetrics(verificationSpec, verificationSamples)
	if err != nil || verificationTarget == nil {
		return errors.New("independent XFOIL receipt has no target metric")
	}
	if err := requireXFOILIndependentTargetAgreement(*sourceTarget, *verificationTarget); err != nil {
		return err
	}
	current, err := service.recomputeXFOILSweep(ctx, spec.RunID, expected.WinnerJob.ProjectID)
	if err != nil {
		return err
	}
	if current.WinnerJob.ID != expected.WinnerJob.ID ||
		current.ScreeningAttemptCount != expected.ScreeningAttemptCount ||
		current.ScreeningCandidateCount != expected.ScreeningCandidateCount ||
		current.SucceededAttemptCount != expected.SucceededAttemptCount ||
		current.FailedAttemptCount != expected.FailedAttemptCount {
		return errors.New("XFOIL screening sweep changed during independent verification")
	}
	return nil
}

func xfoilAlphaGrid(start, end, step float64) ([]float64, error) {
	stepsFloat := (end - start) / step
	steps := int(math.Round(stepsFloat))
	if steps < 1 || math.Abs(stepsFloat-float64(steps)) > 1e-8*math.Max(1, math.Abs(stepsFloat)) {
		return nil, errors.New("XFOIL alpha range must be an integer multiple of alpha_step_deg")
	}
	const maxPolarPoints = 201
	if steps+1 > maxPolarPoints {
		return nil, fmt.Errorf("XFOIL polar requests %d points; maximum is %d", steps+1, maxPolarPoints)
	}
	grid := make([]float64, steps+1)
	for index := range grid {
		value := start + float64(index)*step
		if index == steps {
			value = end
		}
		grid[index] = value
	}
	return grid, nil
}

func nacaFourDigitEnvelope(code string, x float64) (float64, float64, error) {
	if !nacaPattern.MatchString(code) || x <= 0 || x >= 1 {
		return 0, 0, errors.New("NACA four-digit envelope inputs are invalid")
	}
	m := float64(code[0]-'0') / 100
	p := float64(code[1]-'0') / 10
	t, err := strconv.Atoi(code[2:])
	if err != nil || t <= 0 {
		return 0, 0, errors.New("sealed plain-flap support requires a positive NACA thickness")
	}
	thickness := float64(t) / 100
	yt := (0.2969*math.Sqrt(x) - 0.126*x - 0.3516*x*x +
		0.2843*x*x*x - 0.1015*x*x*x*x) * thickness / .2
	yc := 0.0
	if m > 0 {
		if p <= 0 || p >= 1 {
			return 0, 0, errors.New("cambered NACA four-digit flap geometry has an invalid camber position")
		}
		if x < p {
			yc = m / (p * p) * (2*p*x - x*x)
		} else {
			yc = m / ((1 - p) * (1 - p)) * ((1 - 2*p) + 2*p*x - x*x)
		}
	}
	return yc - yt, yc + yt, nil
}

func validateSU2Spec(spec SU2Spec) error {
	if spec.RunID == "" || spec.StageAttemptID == "" || !finite(spec.Mach, spec.AlphaDeg, spec.MeshSizeM) {
		return errors.New("SU2 identifiers and finite inputs are required")
	}
	if spec.Mach < .05 || spec.Mach > .8 || spec.AlphaDeg < -10 || spec.AlphaDeg > 15 ||
		spec.Iterations < 20 || spec.Iterations > 1000 || spec.MeshSizeM < .01 || spec.MeshSizeM > .2 {
		return errors.New("SU2 inputs are outside the supported NACA0012 envelope")
	}
	return nil
}

func openVSPAeroScript(spec WingSpec, threads int) string {
	tipChord := spec.RootChordM * spec.TaperRatio
	area := spec.SemiSpanM * (spec.RootChordM + tipChord)
	mac := spec.RootChordM * (2.0 / 3.0) * (1 + spec.TaperRatio + spec.TaperRatio*spec.TaperRatio) / (1 + spec.TaperRatio)
	f := formatNumber
	return fmt.Sprintf(`void main()
{
    VSPRenew();
    string wing = AddGeom("WING");
    SetGeomName(wing, "AetherOpsWing");
    SetParmVal(wing, "Sym_Planar_Flag", "Sym", SYM_XZ);
    SetDriverGroup(wing, 1, SPAN_WSECT_DRIVER, TAPER_WSECT_DRIVER, ROOTC_WSECT_DRIVER);
    SetParmVal(wing, "SectTess_U", "XSec_1", 24);
    SetParmVal(wing, "Span", "XSec_1", %s);
    SetParmVal(wing, "Taper", "XSec_1", %s);
    SetParmVal(wing, "Root_Chord", "XSec_1", %s);
    SetParmVal(wing, "Sweep", "XSec_1", %s);
    SetParmVal(wing, "Sweep_Location", "XSec_1", 0.25);
    Update();
    WriteVSPFile("aetherops-wing.vsp3", SET_ALL);
    SetAnalysisInputDefaults("VSPAEROComputeGeometry");
    ExecAnalysis("VSPAEROComputeGeometry");
    string analysis = "VSPAEROSweep";
    SetAnalysisInputDefaults(analysis);
    array<double> sref(1, %s); SetDoubleAnalysisInput(analysis, "Sref", sref);
    array<double> bref(1, %s); SetDoubleAnalysisInput(analysis, "bref", bref);
    array<double> cref(1, %s); SetDoubleAnalysisInput(analysis, "cref", cref);
    array<double> mach0(1, %s); SetDoubleAnalysisInput(analysis, "MachStart", mach0);
    array<double> mach1(1, %s); SetDoubleAnalysisInput(analysis, "MachEnd", mach1);
    array<int> machn(1, 1); SetIntAnalysisInput(analysis, "MachNpts", machn);
    array<double> alpha0(1, %s); SetDoubleAnalysisInput(analysis, "AlphaStart", alpha0);
    array<double> alpha1(1, %s); SetDoubleAnalysisInput(analysis, "AlphaEnd", alpha1);
    array<int> alphan(1, %d); SetIntAnalysisInput(analysis, "AlphaNpts", alphan);
    array<int> ncpu(1, %d); SetIntAnalysisInput(analysis, "NCPU", ncpu);
    string results = ExecAnalysis(analysis);
    WriteResultsCSVFile(results, "aetherops-wing-results.csv");
    array<string> rows = GetStringResults(results, "ResultsVec");
    if (rows.length() < %d) Print("AETHEROPS_AERO_ERROR=missing result rows");
    for (uint i = 0; i < %d && i < rows.length(); i++) {
        array<double> a = GetDoubleResults(rows[i], "Alpha");
        array<double> cl = GetDoubleResults(rows[i], "CLtot");
        array<double> cd = GetDoubleResults(rows[i], "CDtot");
        if (a.length() == 0 || cl.length() == 0 || cd.length() == 0) {
            Print("AETHEROPS_AERO_ERROR=incomplete coefficient row");
        } else {
            Print("AETHEROPS_AERO_ALPHA=" + a[a.length()-1] + ",CL=" + cl[cl.length()-1] + ",CD=" + cd[cd.length()-1]);
        }
    }
    while (GetNumTotalErrors() > 0) {
        ErrorObj err = PopLastError(); Print("AETHEROPS_AERO_ERROR=" + err.GetErrorString());
    }
}
`, f(spec.SemiSpanM), f(spec.TaperRatio), f(spec.RootChordM), f(spec.SweepDeg),
		f(area), f(spec.SemiSpanM*2), f(mac), f(spec.Mach), f(spec.Mach),
		f(spec.AlphaStartDeg), f(spec.AlphaEndDeg), spec.AlphaPoints, threads,
		spec.AlphaPoints, spec.AlphaPoints)
}

func openVSPModifyScript(newSweep float64) string {
	return fmt.Sprintf(`void main()
{
    VSPRenew(); ReadVSPFile("source.vsp3");
    array<string> wings = FindGeomsWithName("AetherOpsWing");
    if (wings.length() != 1) { Print("AETHEROPS_MODIFY_ERROR=expected one AetherOpsWing"); return; }
    double oldSweep = GetParmVal(wings[0], "Sweep", "XSec_1");
    SetParmVal(wings[0], "Sweep", "XSec_1", %s); Update();
    double newSweep = GetParmVal(wings[0], "Sweep", "XSec_1");
    WriteVSPFile("modified.vsp3", SET_ALL);
    Print("AETHEROPS_MODIFY_OLD_SWEEP=" + oldSweep);
    Print("AETHEROPS_MODIFY_NEW_SWEEP=" + newSweep);
    while (GetNumTotalErrors() > 0) { ErrorObj err = PopLastError(); Print("AETHEROPS_MODIFY_ERROR=" + err.GetErrorString()); }
}
`, formatNumber(newSweep))
}

func gmshWingGeo(spec MeshSpec) string {
	tipChord := spec.RootChordM * spec.TaperRatio
	offset := spec.SemiSpanM * math.Tan(spec.SweepDeg*math.Pi/180)
	return fmt.Sprintf(`SetFactory("OpenCASCADE");
Point(1) = {0, 0, 0, %s};
Point(2) = {%s, 0, 0, %s};
Point(3) = {%s, %s, 0, %s};
Point(4) = {%s, %s, 0, %s};
Line(1) = {1,2}; Line(2) = {2,3}; Line(3) = {3,4}; Line(4) = {4,1};
Curve Loop(1) = {1,2,3,4}; Plane Surface(1) = {1};
Physical Surface("wing_planform") = {1};
Physical Curve("root") = {1}; Physical Curve("trailing") = {2};
Physical Curve("tip") = {3}; Physical Curve("leading") = {4};
Mesh.Algorithm = 6; Mesh.MshFileVersion = 4.1;
`, formatNumber(spec.MeshSizeM), formatNumber(spec.RootChordM), formatNumber(spec.MeshSizeM),
		formatNumber(offset+tipChord), formatNumber(spec.SemiSpanM), formatNumber(spec.MeshSizeM),
		formatNumber(offset), formatNumber(spec.SemiSpanM), formatNumber(spec.MeshSizeM))
}

func xfoilInput(spec XFOILSpec, settings xfoilSettings) string {
	var input strings.Builder
	input.WriteString("PLOP\nG F\n\n")
	fmt.Fprintf(&input, "NACA %s\n", spec.NACA)
	// Make the standard CM column explicitly refer to quarter chord rather than
	// relying on a mutable XFOIL session default.
	input.WriteString("XYCM 0.25 0\n")
	if settings.Flap != nil {
		input.WriteString("GDES\n")
		fmt.Fprintf(&input, "FLAP %s %s %s\n",
			formatNumber(settings.Flap.HingeXOverC),
			formatNumber(settings.Flap.HingeYOverC),
			formatNumber(settings.Flap.DeflectionDeg))
		input.WriteString("EXEC\n\n")
	}
	input.WriteString("PPAR\n")
	fmt.Fprintf(&input, "N %d\n\n\n", settings.PanelCount)
	input.WriteString("PSAV geometry.dat\n")
	input.WriteString("OPER\n")
	fmt.Fprintf(&input, "VISC %s\nMACH %s\n", formatNumber(spec.Reynolds), formatNumber(spec.Mach))
	input.WriteString("VPAR\n")
	fmt.Fprintf(&input, "N %s\n\n", formatNumber(settings.NCrit))
	fmt.Fprintf(&input, "ITER %d\n", settings.Iterations)
	input.WriteString("PACC\npolar.txt\n\n")
	fmt.Fprintf(&input, "ASEQ %s %s %s\n",
		formatNumber(spec.AlphaStartDeg), formatNumber(spec.AlphaEndDeg), formatNumber(spec.AlphaStepDeg))
	input.WriteString("PACC\n\nQUIT\n")
	return input.String()
}

func parseXFOILPolar(path string) ([]XFOILSample, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read XFOIL polar: %w", err)
	}
	defer file.Close()
	var samples []XFOILSample
	dataSection := false
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if !dataSection {
			if strings.Contains(line, "alpha") && strings.Contains(line, "CL") &&
				strings.Contains(line, "CDp") && strings.Contains(line, "Top_Xtr") && strings.Contains(line, "Bot_Xtr") {
				dataSection = true
			}
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		alpha, err := strconv.ParseFloat(fields[0], 64)
		if err != nil {
			if strings.Trim(fields[0], "-") == "" {
				continue
			}
			return nil, fmt.Errorf("XFOIL polar contains an unexpected row after its data header: %q", line)
		}
		if len(fields) < 7 {
			return nil, fmt.Errorf("XFOIL polar row at alpha %s has %d columns; want at least 7", fields[0], len(fields))
		}
		values := make([]float64, 6)
		for index := range values {
			values[index], err = strconv.ParseFloat(fields[index+1], 64)
			if err != nil {
				return nil, fmt.Errorf("XFOIL polar row at alpha %s has an invalid numeric column: %w", fields[0], err)
			}
		}
		if !finite(alpha, values[0], values[1], values[2], values[3], values[4], values[5]) || values[1] <= 0 {
			return nil, errors.New("XFOIL polar contains non-finite coefficients or non-positive drag")
		}
		// XFOIL 6.99 writes transition positions with four decimal places and
		// can emit 1.0001 for a physical trailing-edge value of 1.0. Accept only
		// one half-unit in the printed last place, then clamp to the closed
		// physical interval. Larger excursions remain a hard numerical failure.
		const transitionPrintTolerance = .0005
		if values[4] < -transitionPrintTolerance || values[4] > 1+transitionPrintTolerance ||
			values[5] < -transitionPrintTolerance || values[5] > 1+transitionPrintTolerance {
			return nil, errors.New("XFOIL polar contains a transition location outside [0,1]")
		}
		values[4] = math.Max(0, math.Min(1, values[4]))
		values[5] = math.Max(0, math.Min(1, values[5]))
		if len(samples) > 0 && alpha <= samples[len(samples)-1].Alpha {
			return nil, errors.New("XFOIL polar alpha rows must be strictly increasing and unique")
		}
		samples = append(samples, XFOILSample{
			Alpha: alpha, CL: values[0], CD: values[1], CDPressure: values[2],
			CM: values[3], TopTransitionX: values[4], BottomTransitionX: values[5],
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if !dataSection {
		return nil, errors.New("XFOIL polar does not contain the expected seven-column header")
	}
	return samples, nil
}

func classifyXFOILPoints(grid []float64, samples []XFOILSample, log string) ([]XFOILPointStatus, error) {
	const alphaTolerance = 0.00051 // XFOIL 6.99 polar output is rounded to 0.001 degree.
	matched := make(map[int]bool, len(samples))
	matchIndex := func(alpha float64) (int, bool) {
		bestIndex := -1
		bestDelta := math.Inf(1)
		for index, requested := range grid {
			delta := math.Abs(requested - alpha)
			if delta < bestDelta {
				bestIndex, bestDelta = index, delta
			}
		}
		return bestIndex, bestIndex >= 0 && bestDelta <= alphaTolerance
	}
	for _, sample := range samples {
		index, ok := matchIndex(sample.Alpha)
		if !ok {
			return nil, fmt.Errorf("XFOIL emitted an unrequested alpha row %.6g", sample.Alpha)
		}
		if matched[index] {
			return nil, fmt.Errorf("XFOIL emitted duplicate rows for requested alpha %.6g", grid[index])
		}
		matched[index] = true
	}

	failed := make(map[int]bool)
	lastAlpha := math.NaN()
	for _, line := range strings.Split(log, "\n") {
		if match := xfoilAlphaPattern.FindStringSubmatch(line); len(match) == 2 {
			if parsed, err := strconv.ParseFloat(match[1], 64); err == nil {
				lastAlpha = parsed
			}
		}
		if strings.Contains(strings.ToLower(line), "convergence failed") && !math.IsNaN(lastAlpha) {
			if index, ok := matchIndex(lastAlpha); ok {
				failed[index] = true
			}
		}
	}

	points := make([]XFOILPointStatus, len(grid))
	for index, alpha := range grid {
		points[index].Alpha = alpha
		switch {
		case matched[index]:
			points[index].Status = xfoilPointConverged
		case failed[index]:
			points[index].Status = xfoilPointNonconverged
			points[index].Reason = "XFOIL reported a convergence failure for the requested alpha"
		default:
			points[index].Status = xfoilPointMissing
			points[index].Reason = "XFOIL emitted no polar row or convergence marker for the requested alpha"
		}
	}
	return points, nil
}

func naca0012Geo(meshSize float64) string {
	const pointsPerSide = 40
	var builder strings.Builder
	builder.WriteString("SetFactory(\"OpenCASCADE\");\n")
	pointID := 1
	// Closed trailing edge: upper surface from TE to LE, then lower surface to TE.
	for i := 0; i <= pointsPerSide; i++ {
		x := .5 * (1 + math.Cos(math.Pi*float64(i)/pointsPerSide))
		y := nacaThickness(x)
		if i == 0 || i == pointsPerSide {
			y = 0
		}
		fmt.Fprintf(&builder, "Point(%d) = {%s, %s, 0, %s};\n", pointID, formatNumber(x), formatNumber(y), formatNumber(meshSize))
		pointID++
	}
	for i := 1; i < pointsPerSide; i++ {
		x := .5 * (1 - math.Cos(math.Pi*float64(i)/pointsPerSide))
		y := -nacaThickness(x)
		fmt.Fprintf(&builder, "Point(%d) = {%s, %s, 0, %s};\n", pointID, formatNumber(x), formatNumber(y), formatNumber(meshSize))
		pointID++
	}
	last := pointID - 1
	farSize := math.Max(meshSize*8, .5)
	fmt.Fprintf(&builder, "Spline(1) = {1:%d,1};\n", last)
	fmt.Fprintf(&builder, "Point(%d) = {-10,-10,0,%s};\n", pointID, formatNumber(farSize))
	p1 := pointID
	pointID++
	fmt.Fprintf(&builder, "Point(%d) = {15,-10,0,%s};\n", pointID, formatNumber(farSize))
	p2 := pointID
	pointID++
	fmt.Fprintf(&builder, "Point(%d) = {15,10,0,%s};\n", pointID, formatNumber(farSize))
	p3 := pointID
	pointID++
	fmt.Fprintf(&builder, "Point(%d) = {-10,10,0,%s};\n", pointID, formatNumber(farSize))
	p4 := pointID
	fmt.Fprintf(&builder, "Line(2)={%d,%d}; Line(3)={%d,%d}; Line(4)={%d,%d}; Line(5)={%d,%d};\n", p1, p2, p2, p3, p3, p4, p4, p1)
	builder.WriteString("Curve Loop(1)={1}; Curve Loop(2)={2,3,4,5}; Plane Surface(1)={2,1};\n")
	builder.WriteString("Physical Curve(\"airfoil\")={1}; Physical Curve(\"farfield\")={2,3,4,5}; Physical Surface(\"fluid\")={1};\n")
	builder.WriteString("Mesh.Algorithm=6; Mesh.Optimize=1;\n")
	return builder.String()
}

func nacaThickness(x float64) float64 {
	return 5 * .12 * (.2969*math.Sqrt(x) - .126*x - .3516*x*x + .2843*x*x*x - .1036*x*x*x*x)
}

func su2Config(spec SU2Spec) string {
	return fmt.Sprintf(`SOLVER= EULER
MATH_PROBLEM= DIRECT
MACH_NUMBER= %s
AOA= %s
FREESTREAM_PRESSURE= 101325.0
FREESTREAM_TEMPERATURE= 288.15
REF_ORIGIN_MOMENT_X= 0.25
REF_ORIGIN_MOMENT_Y= 0.0
REF_ORIGIN_MOMENT_Z= 0.0
REF_LENGTH= 1.0
REF_AREA= 1.0
MARKER_EULER= ( airfoil )
MARKER_FAR= ( farfield )
MARKER_MONITORING= ( airfoil )
MARKER_PLOTTING= ( airfoil )
NUM_METHOD_GRAD= WEIGHTED_LEAST_SQUARES
CFL_NUMBER= 1e3
CFL_ADAPT= NO
ITER= %d
CONV_NUM_METHOD_FLOW= JST
JST_SENSOR_COEFF= ( 0.5, 0.02 )
MUSCL_FLOW= NO
TIME_DISCRE_FLOW= EULER_IMPLICIT
LINEAR_SOLVER= FGMRES
LINEAR_SOLVER_PREC= ILU
LINEAR_SOLVER_ERROR= 1E-10
LINEAR_SOLVER_ITER= 10
MGLEVEL= 3
MGCYCLE= W_CYCLE
MG_PRE_SMOOTH= ( 1, 2, 3, 3 )
MG_POST_SMOOTH= ( 0, 0, 0, 0 )
MG_CORRECTION_SMOOTH= ( 0, 0, 0, 0 )
MG_DAMP_RESTRICTION= 1.0
MG_DAMP_PROLONGATION= 1.0
CONV_FIELD= RMS_DENSITY
CONV_RESIDUAL_MINVAL= -8
CONV_STARTITER= 10
MESH_FILENAME= naca0012.su2
MESH_FORMAT= SU2
TABULAR_FORMAT= CSV
CONV_FILENAME= history
RESTART_FILENAME= restart_flow.dat
SURFACE_FILENAME= surface_flow
OUTPUT_FILES= ( RESTART_ASCII, SURFACE_CSV )
SCREEN_OUTPUT= ( INNER_ITER, RMS_DENSITY, LIFT, DRAG )
HISTORY_OUTPUT= ( ITER, RMS_RES, AERO_COEFF )
WRT_PERFORMANCE= YES
`, formatNumber(spec.Mach), formatNumber(spec.AlphaDeg), spec.Iterations)
}

func parseSU2History(path string) (map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read SU2 history: %w", err)
	}
	defer file.Close()
	// SU2 pads quoted CSV headers with spaces after the closing quote, which is
	// not strict RFC 4180. Its history fields never contain embedded commas, so
	// split the solver format directly and retain strict record-width checks.
	var records [][]string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	expectedFields := 0
	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Split(line, ",")
		for index := range fields {
			fields[index] = strings.Trim(strings.TrimSpace(fields[index]), `"`)
		}
		if expectedFields == 0 {
			expectedFields = len(fields)
		}
		if len(fields) != expectedFields {
			return nil, fmt.Errorf("SU2 history line %d has %d fields, want %d", lineNumber, len(fields), expectedFields)
		}
		records = append(records, fields)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read SU2 history CSV: %w", err)
	}
	if len(records) < 2 {
		return nil, errors.New("SU2 history contains no completed iterations")
	}
	headers := make([]string, len(records[0]))
	for index, header := range records[0] {
		headers[index] = normalizeHeader(header)
	}
	column := func(candidates ...string) int {
		for index, header := range headers {
			for _, candidate := range candidates {
				if header == candidate || strings.Contains(header, candidate) {
					return index
				}
			}
		}
		return -1
	}
	clIndex := column("CL", "LIFT")
	cdIndex := column("CD", "DRAG")
	residualIndex := column("RMS_DENSITY", "RMSRHO", "RMS_DENS")
	if clIndex < 0 || cdIndex < 0 {
		return nil, fmt.Errorf("SU2 history lacks lift/drag columns: %v", headers)
	}
	first, last := records[1], records[len(records)-1]
	parse := func(record []string, index int) (float64, error) {
		if index < 0 || index >= len(record) {
			return 0, errors.New("history column is missing")
		}
		return strconv.ParseFloat(strings.TrimSpace(record[index]), 64)
	}
	cl, errCL := parse(last, clIndex)
	cd, errCD := parse(last, cdIndex)
	if errCL != nil || errCD != nil || !finite(cl, cd) {
		return nil, errors.New("SU2 final aerodynamic coefficients are not finite")
	}
	if math.Abs(cl) <= 1e-8 {
		return nil, fmt.Errorf("SU2 final lift coefficient is trivial: CL=%g", cl)
	}
	metrics := map[string]any{"iterations": len(records) - 1, "cl": cl, "cd": cd}
	if residualIndex >= 0 {
		initial, errInitial := parse(first, residualIndex)
		final, errFinal := parse(last, residualIndex)
		if errInitial != nil || errFinal != nil || !finite(initial, final) || final >= initial {
			return nil, errors.New("SU2 density residual did not decrease")
		}
		metrics["initial_rms_density"] = initial
		metrics["final_rms_density"] = final
		metrics["residual_drop_orders"] = initial - final
	}
	window := 50
	if len(records)-1 < window {
		window = len(records) - 1
	}
	clValues := make([]float64, 0, window)
	cdValues := make([]float64, 0, window)
	for _, record := range records[len(records)-window:] {
		clValue, clErr := parse(record, clIndex)
		cdValue, cdErr := parse(record, cdIndex)
		if clErr != nil || cdErr != nil || !finite(clValue, cdValue) {
			return nil, errors.New("SU2 late-window aerodynamic coefficients are not finite")
		}
		clValues = append(clValues, clValue)
		cdValues = append(cdValues, cdValue)
	}
	clMean, clStddev, clMin, clMax := finiteStats(clValues)
	cdMean, cdStddev, cdMin, cdMax := finiteStats(cdValues)
	metrics["late_window_iterations"] = window
	metrics["cl_late_mean"], metrics["cl_late_stddev"] = clMean, clStddev
	metrics["cl_late_range"] = clMax - clMin
	metrics["cd_late_mean"], metrics["cd_late_stddev"] = cdMean, cdStddev
	metrics["cd_late_range"] = cdMax - cdMin
	return metrics, nil
}

func normalizeHeader(value string) string {
	replacer := strings.NewReplacer("\"", "", "'", "", " ", "", "[", "", "]", "", "-", "_", "/", "_")
	return strings.ToUpper(replacer.Replace(strings.TrimSpace(value)))
}

func requireOpenVSPPathBudget(directory string, fileNames ...string) error {
	const legacyMaxPathWithTerminator = 260
	for _, fileName := range fileNames {
		path := filepath.Join(directory, fileName)
		units := len(utf16.Encode([]rune(path))) + 1
		if units > legacyMaxPathWithTerminator {
			return fmt.Errorf(
				"OpenVSP 3.50.4 cannot safely access engineering path %q: %d UTF-16 units exceed the legacy Windows MAX_PATH limit of %d including the terminator",
				path, units, legacyMaxPathWithTerminator,
			)
		}
	}
	return nil
}

func markerFloat(value, prefix string) (float64, bool) {
	index := strings.Index(value, prefix)
	if index < 0 {
		return 0, false
	}
	text := value[index+len(prefix):]
	if end := strings.IndexAny(text, "\r\n ,"); end >= 0 {
		text = text[:end]
	}
	parsed, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	return parsed, err == nil && finite(parsed)
}

func markerIntPattern(value string, pattern *regexp.Regexp) (int, bool) {
	match := pattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return 0, false
	}
	parsed, err := strconv.Atoi(match[1])
	return parsed, err == nil
}

func formatNumber(value float64) string {
	return strconv.FormatFloat(value, 'g', 12, 64)
}
