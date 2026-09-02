//go:build windows && amd64

package engineering

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/AetherOps/internal/core"
	managedruntime "github.com/djkim0320/AetherOps/internal/runtime"
	"github.com/djkim0320/AetherOps/internal/store"
)

const (
	maxGeneralSU2ConfigBytes = 1 << 20
	maxGeneralSU2MeshBytes   = 512 << 20
	maxGeneralSU2OutputBytes = int64(2) << 30
)

var su2ConfigKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// EngineeringInputs returns immutable project-owned CAS locators suitable for
// a later su2_cfd call. It is read-only and deliberately returns hashes so the
// eventual approval binds bytes rather than only a mutable database id.
func (service *Service) EngineeringInputs(ctx context.Context, runID, attemptID string) ([]store.EngineeringInput, error) {
	projectID, err := service.db.ValidateStageCapability(ctx, runID, attemptID)
	if err != nil {
		return nil, err
	}
	return service.db.ListEngineeringInputs(ctx, projectID, runID)
}

// SU2CFD executes the managed SU2_CFD runtime against an exact project-owned
// SU2 mesh and a normalized direct single-zone configuration. There is no
// built-in geometry, operating point, numerical profile, or hidden fallback.
func (service *Service) SU2CFD(ctx context.Context, spec SU2CFDSpec) (JobResult, error) {
	if err := validateSU2CFDSpec(spec); err != nil {
		return JobResult{}, err
	}
	if _, err := RequireNativeSU2Host(); err != nil {
		return JobResult{}, err
	}
	return service.execute(ctx, spec.RunID, spec.StageAttemptID, "su2_cfd",
		"su2", managedruntime.PinnedSU2Version, spec,
		func(parent context.Context, directory string) (operationOutput, error) {
			projectID, err := service.db.ValidateEngineeringCapability(parent, spec.RunID, spec.StageAttemptID)
			if err != nil {
				return operationOutput{}, err
			}
			meshInput, err := service.db.ResolveEngineeringInput(parent, projectID, spec.RunID,
				spec.MeshSource, spec.MeshID, spec.MeshSHA256)
			if err != nil {
				return operationOutput{}, fmt.Errorf("resolve SU2 mesh input: %w", err)
			}
			if meshInput.Size > maxGeneralSU2MeshBytes {
				return operationOutput{}, fmt.Errorf("SU2 mesh exceeds %d bytes", maxGeneralSU2MeshBytes)
			}
			meshPath := filepath.Join(directory, "mesh.su2")
			if err := service.copyVerifiedEngineeringInput(meshInput, meshPath); err != nil {
				return operationOutput{}, fmt.Errorf("stage SU2 mesh: %w", err)
			}
			meshMetrics, err := inspectGeneralSU2Mesh(meshPath)
			if err != nil {
				return operationOutput{}, err
			}

			var sourceConfig []byte
			sourceConfigPath := ""
			if spec.ConfigSource != "" {
				configInput, resolveErr := service.db.ResolveEngineeringInput(parent, projectID, spec.RunID,
					spec.ConfigSource, spec.ConfigID, spec.ConfigSHA256)
				if resolveErr != nil {
					return operationOutput{}, fmt.Errorf("resolve SU2 config input: %w", resolveErr)
				}
				if configInput.Size > maxGeneralSU2ConfigBytes {
					return operationOutput{}, fmt.Errorf("SU2 config exceeds %d bytes", maxGeneralSU2ConfigBytes)
				}
				sourceConfigPath = filepath.Join(directory, "source.cfg")
				if err := service.copyVerifiedEngineeringInput(configInput, sourceConfigPath); err != nil {
					return operationOutput{}, fmt.Errorf("stage SU2 config: %w", err)
				}
				sourceConfig, err = os.ReadFile(sourceConfigPath)
				if err != nil {
					return operationOutput{}, err
				}
			}
			effectiveConfig, err := normalizedGeneralSU2Config(spec, sourceConfig)
			if err != nil {
				return operationOutput{}, err
			}
			configPath := filepath.Join(directory, "case.cfg")
			if err := os.WriteFile(configPath, effectiveConfig, 0o600); err != nil {
				return operationOutput{}, err
			}

			operationCtx, cancel := context.WithTimeout(parent, time.Duration(spec.TimeoutSeconds)*time.Second)
			defer cancel()
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
			process, runErr := service.runCommand(operationCtx, directory,
				service.runtime.SU2CFDExecutable, "", environment, su2Args...)
			logPath := filepath.Join(directory, "su2.log")
			if writeErr := writeLog(logPath, process); writeErr != nil {
				return operationOutput{}, errors.Join(runErr, writeErr)
			}
			if runErr != nil {
				return operationOutput{}, runErr
			}
			combinedLog := process.stdout + "\n" + process.stderr
			if regexp.MustCompile(`(?im)^\s*Error(?:\s+in\b|\s*:)`).MatchString(combinedLog) {
				return operationOutput{}, errors.New("SU2 emitted an error marker")
			}
			historyPath := filepath.Join(directory, "history.csv")
			history, err := parseGeneralSU2History(historyPath)
			if err != nil {
				return operationOutput{}, err
			}
			converged := strings.Contains(combinedLog, "All convergence criteria satisfied.")
			termination := "completed"
			if converged {
				termination = "convergence_criteria_satisfied"
			} else if strings.Contains(combinedLog, "Maximum number of iterations reached") {
				termination = "iteration_limit"
			}
			effectiveDigest := sha256.Sum256(effectiveConfig)
			metrics := map[string]any{
				"case_id":                 spec.CaseID,
				"solver":                  spec.Solver,
				"turbulence_model":        spec.TurbulenceModel,
				"mesh_sha256":             spec.MeshSHA256,
				"effective_config_sha256": hex.EncodeToString(effectiveDigest[:]),
				"mesh_dimension":          meshMetrics.Dimension,
				"mesh_nodes":              meshMetrics.Nodes,
				"mesh_elements":           meshMetrics.Elements,
				"mesh_markers":            meshMetrics.Markers,
				"history_rows":            history.Rows,
				"history_columns":         history.Columns,
				"converged":               converged,
				"termination_reason":      termination,
				"final_values":            history.FinalValues,
			}
			if spec.ConfigSHA256 != "" {
				metrics["source_config_sha256"] = spec.ConfigSHA256
			}
			if history.FinalIteration != nil {
				metrics["final_iteration"] = *history.FinalIteration
			}
			for target, candidates := range map[string][]string{
				"cl": {"CL", "LIFT"}, "cd": {"CD", "DRAG"},
				"final_rms_density": {"RMS_DENSITY", "RMSRHO", "RMS_DENS"},
			} {
				if value, ok := genericHistoryValue(history.FinalValues, candidates...); ok {
					metrics[target] = value
				}
			}
			files, err := collectGeneralSU2Outputs(directory, sourceConfigPath, spec.OutputFiles)
			if err != nil {
				return operationOutput{}, err
			}
			return operationOutput{
				metrics: metrics, files: files,
				executables: []executableReceipt{su2Info}, exitCodes: []int{process.exitCode},
				numericallyValid: true,
			}, nil
		})
}

func validateSU2CFDSpec(spec SU2CFDSpec) error {
	if strings.TrimSpace(spec.RunID) == "" || strings.TrimSpace(spec.StageAttemptID) == "" {
		return errors.New("SU2 run and stage attempt are required")
	}
	plan := core.SU2CasePlan{
		ID: spec.CaseID, MeshSource: spec.MeshSource, MeshID: spec.MeshID, MeshSHA256: spec.MeshSHA256,
		ConfigSource: spec.ConfigSource, ConfigID: spec.ConfigID, ConfigSHA256: spec.ConfigSHA256,
		Solver: spec.Solver, TurbulenceModel: spec.TurbulenceModel,
		ConfigOverrides: spec.ConfigOverrides, OutputFiles: spec.OutputFiles, TimeoutSeconds: spec.TimeoutSeconds,
	}
	if err := plan.Validate(); err != nil {
		return err
	}
	return validateGeneralSU2Overrides(spec.ConfigOverrides)
}

func (service *Service) copyVerifiedEngineeringInput(input store.EngineeringInput, destination string) error {
	source, err := service.cas.Path(input.BlobHash)
	if err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		_ = out.Close()
		if !committed {
			_ = os.Remove(destination)
		}
	}()
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(out, hasher), io.LimitReader(in, input.Size+1))
	if err != nil {
		return err
	}
	if written != input.Size || hex.EncodeToString(hasher.Sum(nil)) != input.BlobHash {
		return errors.New("engineering input CAS readback does not match its metadata")
	}
	if err := out.Sync(); err != nil {
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	committed = true
	return nil
}

type generalSU2MeshMetrics struct {
	Dimension int
	Nodes     int
	Elements  int
	Markers   int
}

func inspectGeneralSU2Mesh(path string) (generalSU2MeshMetrics, error) {
	file, err := os.Open(path)
	if err != nil {
		return generalSU2MeshMetrics{}, err
	}
	defer file.Close()
	metrics := generalSU2MeshMetrics{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.IndexByte(line, 0) >= 0 {
			return generalSU2MeshMetrics{}, errors.New("SU2 mesh must be an ASCII SU2 mesh")
		}
		for key, target := range map[string]*int{
			"NDIME": &metrics.Dimension, "NPOIN": &metrics.Nodes,
			"NELEM": &metrics.Elements, "NMARK": &metrics.Markers,
		} {
			if !strings.HasPrefix(line, key) {
				continue
			}
			_, value, ok := strings.Cut(line, "=")
			if !ok {
				return generalSU2MeshMetrics{}, fmt.Errorf("SU2 mesh has malformed %s", key)
			}
			fields := strings.Fields(strings.TrimSpace(value))
			if len(fields) == 0 {
				return generalSU2MeshMetrics{}, fmt.Errorf("SU2 mesh has empty %s", key)
			}
			parsed, parseErr := strconv.Atoi(fields[0])
			if parseErr != nil || parsed <= 0 {
				return generalSU2MeshMetrics{}, fmt.Errorf("SU2 mesh has invalid %s", key)
			}
			*target = parsed
		}
	}
	if err := scanner.Err(); err != nil {
		return generalSU2MeshMetrics{}, err
	}
	if metrics.Dimension != 2 && metrics.Dimension != 3 {
		return generalSU2MeshMetrics{}, errors.New("SU2 mesh dimension must be 2 or 3")
	}
	if metrics.Nodes == 0 || metrics.Elements == 0 || metrics.Markers == 0 {
		return generalSU2MeshMetrics{}, errors.New("SU2 mesh omits nodes, elements, or boundary markers")
	}
	return metrics, nil
}

var managedGeneralSU2Keys = map[string]bool{
	"SOLVER": true, "KIND_TURB_MODEL": true, "MATH_PROBLEM": true,
	"MESH_FILENAME": true, "MESH_FORMAT": true, "RESTART_SOL": true,
	"CONFIG_LIST": true, "OUTPUT_FILES": true, "TABULAR_FORMAT": true,
	"OUTPUT_PRECISION": true,
	"CONV_FILENAME":    true, "RESTART_FILENAME": true, "SURFACE_FILENAME": true,
	"VOLUME_FILENAME": true, "BREAKDOWN_FILENAME": true, "MESH_OUT_FILENAME": true,
	"SOLUTION_FILENAME": true, "SOLUTION_ADJ_FILENAME": true, "RESTART_ADJ_FILENAME": true,
	"VOLUME_ADJ_FILENAME": true, "SURFACE_ADJ_FILENAME": true, "SURFACE_SENS_FILENAME": true,
	"VOLUME_SENS_FILENAME": true, "VALUE_OBJFUNC_FILENAME": true, "GRAD_OBJFUNC_FILENAME": true,
	"WRT_RESTART_OVERWRITE": true, "WRT_SURFACE_OVERWRITE": true,
	"WRT_VOLUME_OVERWRITE": true, "WRT_PERFORMANCE": true,
}

func normalizedGeneralSU2Config(spec SU2CFDSpec, source []byte) ([]byte, error) {
	values, err := parseGeneralSU2Config(source)
	if err != nil {
		return nil, err
	}
	for key, expected := range map[string]string{
		"SOLVER": spec.Solver, "KIND_TURB_MODEL": spec.TurbulenceModel, "MATH_PROBLEM": "DIRECT",
	} {
		if value, exists := values[key]; exists && !strings.EqualFold(strings.TrimSpace(value), expected) {
			return nil, fmt.Errorf("source SU2 config %s conflicts with approved value %s", key, expected)
		}
	}
	if value, exists := values["MESH_FORMAT"]; exists && !strings.EqualFold(strings.TrimSpace(value), "SU2") {
		return nil, errors.New("general SU2 adapter accepts only an ASCII SU2 mesh")
	}
	if value, exists := values["RESTART_SOL"]; exists && !strings.EqualFold(strings.TrimSpace(value), "NO") {
		return nil, errors.New("general SU2 adapter does not accept restart input")
	}
	for key := range values {
		if managedGeneralSU2Keys[key] {
			delete(values, key)
			continue
		}
		if fileBearingSU2Key(key) {
			return nil, fmt.Errorf("SU2 option %s can reference an unmanaged file or path", key)
		}
	}
	if err := validateGeneralSU2Overrides(spec.ConfigOverrides); err != nil {
		return nil, err
	}
	for key, value := range spec.ConfigOverrides {
		if managedGeneralSU2Keys[key] || fileBearingSU2Key(key) {
			return nil, fmt.Errorf("SU2 override %s is owned by the isolated adapter", key)
		}
		values[key] = strings.TrimSpace(value)
	}
	if strings.EqualFold(values["TIME_DOMAIN"], "YES") {
		if err := validatePositiveSU2IterationLimit(values, "TIME_ITER"); err != nil {
			return nil, err
		}
	} else if err := validatePositiveSU2IterationLimit(values, "ITER"); err != nil {
		return nil, err
	}
	outputNames := make([]string, 0, len(spec.OutputFiles))
	for _, output := range spec.OutputFiles {
		switch output {
		case "surface_csv":
			outputNames = append(outputNames, "SURFACE_CSV")
		case "volume_paraview_ascii":
			outputNames = append(outputNames, "PARAVIEW_ASCII")
		case "restart_ascii":
			outputNames = append(outputNames, "RESTART_ASCII")
		}
	}
	values["SOLVER"] = spec.Solver
	values["KIND_TURB_MODEL"] = spec.TurbulenceModel
	values["MATH_PROBLEM"] = "DIRECT"
	values["MESH_FILENAME"] = "mesh.su2"
	values["MESH_FORMAT"] = "SU2"
	values["RESTART_SOL"] = "NO"
	values["TABULAR_FORMAT"] = "CSV"
	values["OUTPUT_PRECISION"] = "12"
	values["OUTPUT_FILES"] = "(" + strings.Join(outputNames, ", ") + ")"
	values["CONV_FILENAME"] = "history"
	values["RESTART_FILENAME"] = "restart_flow"
	values["SURFACE_FILENAME"] = "surface_flow"
	values["VOLUME_FILENAME"] = "volume_flow"
	values["BREAKDOWN_FILENAME"] = "forces_breakdown.dat"
	values["WRT_RESTART_OVERWRITE"] = "YES"
	values["WRT_SURFACE_OVERWRITE"] = "YES"
	values["WRT_VOLUME_OVERWRITE"] = "YES"
	values["WRT_PERFORMANCE"] = "YES"
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var out strings.Builder
	out.WriteString("% AetherOps normalized project-owned SU2_CFD case\n")
	for _, key := range keys {
		fmt.Fprintf(&out, "%s= %s\n", key, values[key])
	}
	return []byte(out.String()), nil
}

func parseGeneralSU2Config(data []byte) (map[string]string, error) {
	values := make(map[string]string)
	if len(data) == 0 {
		return values, nil
	}
	if len(data) > maxGeneralSU2ConfigBytes || !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		return nil, errors.New("SU2 config must be bounded UTF-8-compatible text")
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 64*1024), maxGeneralSU2ConfigBytes)
	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := scanner.Text()
		if comment := strings.IndexByte(line, '%'); comment >= 0 {
			line = line[:comment]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if !ok || !su2ConfigKeyPattern.MatchString(key) || value == "" {
			return nil, fmt.Errorf("SU2 config line %d is not a single KEY=VALUE assignment", lineNumber)
		}
		if _, duplicate := values[key]; duplicate {
			return nil, fmt.Errorf("SU2 config repeats option %s", key)
		}
		validate := validateGeneralSU2Value
		if managedGeneralSU2Keys[key] {
			validate = validateGeneralSU2ManagedValue
		}
		if err := validate(value); err != nil {
			return nil, fmt.Errorf("SU2 config option %s: %w", key, err)
		}
		values[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return values, nil
}

func validateGeneralSU2Overrides(values map[string]string) error {
	if len(values) > 256 {
		return errors.New("SU2 configuration has more than 256 overrides")
	}
	total := 0
	for key, value := range values {
		if !su2ConfigKeyPattern.MatchString(key) {
			return fmt.Errorf("invalid SU2 option name %q", key)
		}
		if len(value) > 4096 {
			return fmt.Errorf("SU2 option %s exceeds 4096 bytes", key)
		}
		total += len(key) + len(value)
		if total > 64<<10 {
			return errors.New("SU2 configuration overrides exceed 64 KiB")
		}
		if err := validateGeneralSU2Value(strings.TrimSpace(value)); err != nil {
			return fmt.Errorf("SU2 option %s: %w", key, err)
		}
	}
	return nil
}

func validateGeneralSU2Value(value string) error {
	if err := validateGeneralSU2ManagedValue(value); err != nil {
		return err
	}
	if strings.ContainsAny(value, "%\\/") || strings.Contains(value, "..") || strings.Contains(value, "://") {
		return errors.New("value contains comment or path syntax")
	}
	return nil
}

func validateGeneralSU2ManagedValue(value string) error {
	if value == "" {
		return errors.New("value is empty")
	}
	for _, character := range value {
		if character < 0x20 || character > 0x7e {
			return errors.New("value must contain printable ASCII only")
		}
	}
	return nil
}

func fileBearingSU2Key(key string) bool {
	return strings.Contains(key, "FILENAME") || strings.Contains(key, "FILE_NAME") ||
		strings.HasSuffix(key, "_FILE") || strings.Contains(key, "PATH") || key == "CONFIG_LIST"
}

func validatePositiveSU2IterationLimit(values map[string]string, key string) error {
	raw := strings.TrimSpace(values[key])
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > 1_000_000 {
		return fmt.Errorf("SU2 %s must be an integer from 1 through 1000000", key)
	}
	return nil
}

type generalSU2History struct {
	Rows           int
	Columns        int
	FinalIteration *int
	FinalValues    map[string]float64
}

func parseGeneralSU2History(path string) (generalSU2History, error) {
	file, err := os.Open(path)
	if err != nil {
		return generalSU2History{}, fmt.Errorf("read SU2 history: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	var headers []string
	var last []string
	rows := 0
	for lineNumber := 1; scanner.Scan(); lineNumber++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Split(line, ",")
		for index := range fields {
			fields[index] = strings.Trim(strings.TrimSpace(fields[index]), `"`)
		}
		if headers == nil {
			if len(fields) == 0 || len(fields) > 256 {
				return generalSU2History{}, errors.New("SU2 history column count is invalid")
			}
			headers = make([]string, len(fields))
			seen := make(map[string]struct{}, len(fields))
			for index, field := range fields {
				headers[index] = genericSU2HistoryKey(field)
				if headers[index] == "" {
					return generalSU2History{}, fmt.Errorf("SU2 history column %d has no stable name", index+1)
				}
				if _, duplicate := seen[headers[index]]; duplicate {
					return generalSU2History{}, fmt.Errorf("SU2 history repeats normalized column %s", headers[index])
				}
				seen[headers[index]] = struct{}{}
			}
			continue
		}
		if len(fields) != len(headers) {
			return generalSU2History{}, fmt.Errorf("SU2 history line %d has %d fields, want %d", lineNumber, len(fields), len(headers))
		}
		rows++
		if rows > 1_000_000 {
			return generalSU2History{}, errors.New("SU2 history exceeds one million rows")
		}
		last = fields
	}
	if err := scanner.Err(); err != nil {
		return generalSU2History{}, err
	}
	if rows == 0 || last == nil {
		return generalSU2History{}, errors.New("SU2 history contains no completed rows")
	}
	finalValues := make(map[string]float64)
	for index, raw := range last {
		value, parseErr := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if parseErr != nil {
			continue
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return generalSU2History{}, fmt.Errorf("SU2 history final value %s is not finite", headers[index])
		}
		finalValues[headers[index]] = value
	}
	if len(finalValues) == 0 {
		return generalSU2History{}, errors.New("SU2 history final row has no finite numerical values")
	}
	var finalIteration *int
	for _, key := range []string{"TIME_ITER", "OUTER_ITER", "INNER_ITER", "ITER"} {
		if value, ok := finalValues[key]; ok && value >= 0 && value <= 1_000_000 && math.Trunc(value) == value {
			converted := int(value)
			if finalIteration == nil || converted > *finalIteration {
				finalIteration = &converted
			}
		}
	}
	return generalSU2History{Rows: rows, Columns: len(headers), FinalIteration: finalIteration, FinalValues: finalValues}, nil
}

func genericSU2HistoryKey(value string) string {
	value = normalizeHeader(value)
	var out strings.Builder
	lastUnderscore := false
	for _, character := range value {
		if character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' {
			out.WriteRune(character)
			lastUnderscore = false
		} else if !lastUnderscore {
			out.WriteByte('_')
			lastUnderscore = true
		}
		if out.Len() >= 64 {
			break
		}
	}
	return strings.Trim(out.String(), "_")
}

func genericHistoryValue(values map[string]float64, candidates ...string) (float64, bool) {
	for _, candidate := range candidates {
		if value, ok := values[candidate]; ok {
			return value, true
		}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, candidate := range candidates {
		for _, key := range keys {
			if strings.Contains(key, candidate) {
				return values[key], true
			}
		}
	}
	return 0, false
}

func collectGeneralSU2Outputs(directory, sourceConfigPath string, requested []string) ([]outputFile, error) {
	files := []outputFile{
		{filepath.Join(directory, "mesh.su2"), "mesh_input", "mesh.su2", "application/vnd.su2.mesh"},
		{filepath.Join(directory, "case.cfg"), "config", "case.cfg", "text/plain"},
		{filepath.Join(directory, "history.csv"), "history", "history.csv", "text/csv"},
		{filepath.Join(directory, "su2.log"), "log", "su2.log", "text/plain"},
	}
	if sourceConfigPath != "" {
		files = append(files, outputFile{sourceConfigPath, "config_source", "source.cfg", "text/plain"})
	}
	total := int64(0)
	for _, file := range files {
		info, err := os.Lstat(file.path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 {
			return nil, fmt.Errorf("SU2 required output %s is not a non-empty regular file", file.name)
		}
		total += info.Size()
		if total > maxGeneralSU2OutputBytes {
			return nil, errors.New("SU2 managed outputs exceed the byte limit")
		}
	}
	wanted := make(map[string]bool, len(requested))
	found := make(map[string]bool, len(requested))
	for _, value := range requested {
		wanted[value] = true
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		role, mediaType, outputKind := "", "", ""
		switch {
		case wanted["surface_csv"] && strings.HasPrefix(name, "surface_flow") && strings.HasSuffix(strings.ToLower(name), ".csv"):
			role, mediaType, outputKind = "surface", "text/csv", "surface_csv"
		case wanted["volume_paraview_ascii"] && strings.HasPrefix(name, "volume_flow") &&
			(strings.HasSuffix(strings.ToLower(name), ".vtk") || strings.HasSuffix(strings.ToLower(name), ".vtu")):
			role, mediaType, outputKind = "volume", "application/vnd.vtk", "volume_paraview_ascii"
		case wanted["restart_ascii"] && strings.HasPrefix(name, "restart_flow") &&
			(strings.HasSuffix(strings.ToLower(name), ".dat") || strings.HasSuffix(strings.ToLower(name), ".csv")):
			role, mediaType, outputKind = "restart", "text/plain", "restart_ascii"
		default:
			continue
		}
		info, statErr := os.Lstat(filepath.Join(directory, name))
		if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() <= 0 {
			return nil, fmt.Errorf("SU2 output %s is not a non-empty regular file", name)
		}
		total += info.Size()
		if total > maxGeneralSU2OutputBytes || len(files) >= 64 {
			return nil, errors.New("SU2 managed outputs exceed the file or byte limit")
		}
		found[outputKind] = true
		files = append(files, outputFile{filepath.Join(directory, name), role, name, mediaType})
	}
	for _, output := range requested {
		if !found[output] {
			return nil, fmt.Errorf("SU2 did not produce requested managed output %s", output)
		}
	}
	return files, nil
}
