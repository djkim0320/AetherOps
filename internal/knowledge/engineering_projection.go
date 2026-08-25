package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"

	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/store"
)

const engineeringReceiptSchema = 1

const engineeringProjectionContract = "aetherops-deterministic-engineering-projection-v1"

type engineeringProjectionReceipt struct {
	Schema           int                        `json:"schema"`
	JobID            string                     `json:"job_id"`
	RunID            string                     `json:"run_id"`
	StageAttemptID   string                     `json:"stage_attempt_id"`
	Operation        string                     `json:"operation"`
	Spec             json.RawMessage            `json:"spec"`
	SpecSHA256       string                     `json:"spec_sha256"`
	Executables      []json.RawMessage          `json:"executables"`
	Threads          int                        `json:"threads"`
	StartedAt        string                     `json:"started_at"`
	CompletedAt      string                     `json:"completed_at"`
	ExitCodes        []int                      `json:"exit_codes"`
	Executed         bool                       `json:"executed"`
	NumericallyValid bool                       `json:"numerically_valid"`
	Metrics          map[string]json.RawMessage `json:"metrics"`
	Artifacts        []json.RawMessage          `json:"artifacts"`
}

type engineeringMetricKind = core.EngineeringMetricKind

const (
	engineeringMetricInteger = core.EngineeringMetricInteger
	engineeringMetricDecimal = core.EngineeringMetricDecimal
	engineeringMetricAngle   = core.EngineeringMetricAngle
	engineeringMetricLength  = core.EngineeringMetricLength
	engineeringMetricBoolean = core.EngineeringMetricBoolean
	engineeringMetricString  = core.EngineeringMetricString
)

type engineeringMetricContract = core.EngineeringMetricContract

var engineeringMetricContracts = map[string]map[string]engineeringMetricContract{
	"openvsp_wing_aero": {
		"sample_count": {Kind: engineeringMetricInteger},
	},
	"openvsp_modify_wing": {
		"old_sweep_deg": {Kind: engineeringMetricAngle, Unit: "deg"},
		"new_sweep_deg": {Kind: engineeringMetricAngle, Unit: "deg"},
	},
	"gmsh_wing_mesh": {
		"nodes":     {Kind: engineeringMetricInteger},
		"elements":  {Kind: engineeringMetricInteger},
		"coherence": {Kind: engineeringMetricString},
	},
	"xfoil_polar": {
		"sample_count":             {Kind: engineeringMetricInteger},
		"requested_point_count":    {Kind: engineeringMetricInteger},
		"nonconverged_point_count": {Kind: engineeringMetricInteger},
		"missing_point_count":      {Kind: engineeringMetricInteger},
	},
	"su2_naca0012": core.SU2MetricContractsV1(),
}

type engineeringArtifactMetricKind string

const (
	engineeringArtifactMetricArray  engineeringArtifactMetricKind = "array"
	engineeringArtifactMetricObject engineeringArtifactMetricKind = "object"
)

var engineeringArtifactOnlyMetrics = map[string]map[string]engineeringArtifactMetricKind{
	"openvsp_wing_aero": {"samples": engineeringArtifactMetricArray},
	"xfoil_polar": {
		"samples":                   engineeringArtifactMetricArray,
		"points":                    engineeringArtifactMetricArray,
		"optimization":              engineeringArtifactMetricObject,
		"optimization_dossier":      engineeringArtifactMetricObject,
		"optimization_verification": engineeringArtifactMetricObject,
	},
}

// deterministicEngineeringProjection converts only verified scalar receipt
// metrics into AnalysisRun/Observation-shaped core entities. Solver cells,
// iterations, meshes, and long series remain in their CAS artifacts.
func (service *Service) deterministicEngineeringProjection(
	ctx context.Context,
	run core.Run,
) (store.KnowledgeProjection, error) {
	if service.DB == nil || service.CAS == nil {
		return store.KnowledgeProjection{}, errors.New("engineering knowledge projection requires storage and CAS")
	}
	results, err := service.DB.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		return store.KnowledgeProjection{}, err
	}
	sort.Slice(results, func(i, j int) bool { return results[i].Job.ID < results[j].Job.ID })
	projection := store.KnowledgeProjection{}
	for _, result := range results {
		if result.Job.ProjectID != run.ProjectID || result.Job.RunID != run.ID || result.Job.Status != "succeeded" {
			return projection, fmt.Errorf("engineering job %s is outside the successful run scope", result.Job.ID)
		}
		receiptArtifact, err := engineeringReceiptArtifact(result)
		if err != nil {
			return projection, err
		}
		data, err := service.CAS.ReadVerified(receiptArtifact.BlobHash)
		if err != nil {
			return projection, fmt.Errorf("read engineering receipt %s from CAS: %w", result.Job.ID, err)
		}
		receipt, err := decodeEngineeringProjectionReceipt(data)
		if err != nil {
			return projection, fmt.Errorf("decode engineering receipt %s: %w", result.Job.ID, err)
		}
		if err := validateEngineeringProjectionReceipt(result.Job, run, receipt); err != nil {
			return projection, err
		}
		jobProjection, err := projectEngineeringReceipt(result.Job, receiptArtifact, receipt)
		if err != nil {
			return projection, err
		}
		projection.Entities = append(projection.Entities, jobProjection.Entities...)
		projection.Assertions = append(projection.Assertions, jobProjection.Assertions...)
		projection.Evidence = append(projection.Evidence, jobProjection.Evidence...)
	}
	return projection, nil
}

func (service *Service) recordDeterministicEngineeringProjection(
	ctx context.Context,
	run core.Run,
	candidate store.KnowledgeGeneration,
) error {
	results, err := service.DB.ListRunEngineeringResults(ctx, run.ID)
	if err != nil {
		return err
	}
	contractHash := engineeringProjectionHash([]byte(engineeringProjectionContract))
	for _, result := range results {
		receipt, err := engineeringReceiptArtifact(result)
		if err != nil {
			return err
		}
		batchID := "kext_eng_" + engineeringProjectionHash([]byte(candidate.ID + "\x00" + result.Job.ID))[:24]
		if _, err := service.DB.CreateKnowledgeExtractionBatch(ctx, store.KnowledgeExtractionBatch{
			ProjectID: run.ProjectID, GenerationID: candidate.ID, ID: batchID,
			RunID: run.ID, ArtifactID: receipt.ArtifactID, SourceKind: "engineering",
			ExtractorContractSHA256: contractHash, InputSHA256: receipt.BlobHash,
		}); err != nil {
			return fmt.Errorf("create deterministic engineering batch %s: %w", result.Job.ID, err)
		}
		if err := service.DB.TransitionKnowledgeExtractionBatch(
			ctx, run.ProjectID, candidate.ID, batchID, "queued", "reviewing",
			store.KnowledgeExtractionBatchUpdate{},
		); err != nil {
			return err
		}
		update := store.KnowledgeExtractionBatchUpdate{
			OutputSHA256: receipt.BlobHash, PatchBlobHash: receipt.BlobHash,
		}
		if err := service.DB.TransitionKnowledgeExtractionBatch(
			ctx, run.ProjectID, candidate.ID, batchID, "reviewing", "validated", update,
		); err != nil {
			return err
		}
		if err := service.DB.TransitionKnowledgeExtractionBatch(
			ctx, run.ProjectID, candidate.ID, batchID, "validated", "applied", update,
		); err != nil {
			return err
		}
	}
	return nil
}

func engineeringReceiptArtifact(result store.EngineeringResult) (store.EngineeringJobArtifact, error) {
	var receipt store.EngineeringJobArtifact
	for _, artifact := range result.Artifacts {
		if artifact.ArtifactID != result.Job.ReceiptArtifactID {
			continue
		}
		if receipt.ArtifactID != "" {
			return store.EngineeringJobArtifact{}, fmt.Errorf("engineering job %s has duplicate receipt links", result.Job.ID)
		}
		receipt = artifact
	}
	if receipt.ArtifactID == "" || receipt.Role != "receipt" || receipt.MediaType != "application/json" {
		return store.EngineeringJobArtifact{}, fmt.Errorf("engineering job %s has no canonical JSON receipt", result.Job.ID)
	}
	return receipt, nil
}

func decodeEngineeringProjectionReceipt(data []byte) (engineeringProjectionReceipt, error) {
	var receipt engineeringProjectionReceipt
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return receipt, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return receipt, errors.New("engineering receipt contains multiple JSON values")
		}
		return receipt, err
	}
	return receipt, nil
}

func validateEngineeringProjectionReceipt(job store.EngineeringJob, run core.Run, receipt engineeringProjectionReceipt) error {
	if receipt.Schema != engineeringReceiptSchema || receipt.JobID != job.ID || receipt.RunID != run.ID ||
		receipt.StageAttemptID != job.StageAttemptID || receipt.Operation != job.Operation ||
		receipt.SpecSHA256 != job.SpecSHA256 {
		return fmt.Errorf("engineering receipt %s lineage does not match its durable job", job.ID)
	}
	if !receipt.Executed || !receipt.NumericallyValid || receipt.Threads < 1 || len(receipt.ExitCodes) == 0 {
		return fmt.Errorf("engineering receipt %s is not an executed numerically valid result", job.ID)
	}
	for _, code := range receipt.ExitCodes {
		if code != 0 {
			return fmt.Errorf("engineering receipt %s records non-zero exit code %d", job.ID, code)
		}
	}
	if len(receipt.Metrics) == 0 || len(receipt.Spec) == 0 || !json.Valid(receipt.Spec) {
		return fmt.Errorf("engineering receipt %s omits metrics or its canonical spec", job.ID)
	}
	if engineeringProjectionHash([]byte(job.SpecJSON)) != job.SpecSHA256 {
		return fmt.Errorf("engineering receipt %s durable job spec hash is invalid", job.ID)
	}
	// execution receipts are persisted with json.MarshalIndent. RawMessage keeps
	// that surrounding indentation when decoded, so hashing receipt.Spec bytes
	// directly incorrectly rejects the exact durable specification. Compare the
	// two JSON values after whitespace-only compaction while keeping the durable
	// job's original-byte hash check above as the authority boundary.
	var receiptSpecCompact, durableSpecCompact bytes.Buffer
	if err := json.Compact(&receiptSpecCompact, receipt.Spec); err != nil {
		return fmt.Errorf("engineering receipt %s canonical spec is invalid: %w", job.ID, err)
	}
	if err := json.Compact(&durableSpecCompact, []byte(job.SpecJSON)); err != nil {
		return fmt.Errorf("engineering receipt %s durable job spec is invalid: %w", job.ID, err)
	}
	if !bytes.Equal(receiptSpecCompact.Bytes(), durableSpecCompact.Bytes()) {
		return fmt.Errorf("engineering receipt %s canonical spec does not match its durable job", job.ID)
	}
	return nil
}

func projectEngineeringReceipt(
	job store.EngineeringJob,
	receiptArtifact store.EngineeringJobArtifact,
	receipt engineeringProjectionReceipt,
) (store.KnowledgeProjection, error) {
	contracts, supported := engineeringMetricContracts[job.Operation]
	if !supported {
		return store.KnowledgeProjection{}, fmt.Errorf("engineering operation %q has no deterministic graph adapter", job.Operation)
	}
	ignored := engineeringArtifactOnlyMetrics[job.Operation]
	for key, value := range receipt.Metrics {
		if _, known := contracts[key]; known {
			continue
		}
		if kind, artifactOnly := ignored[key]; artifactOnly {
			if err := validateEngineeringArtifactOnlyMetric(value, kind); err != nil {
				return store.KnowledgeProjection{}, fmt.Errorf("engineering metric %s must remain a CAS %s: %w", key, kind, err)
			}
			continue
		}
		return store.KnowledgeProjection{}, fmt.Errorf("engineering metric %q has no versioned unit/type contract", key)
	}

	keys := make([]string, 0, len(contracts))
	for key := range contracts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	runEntityID := engineeringProjectionID("analysis-run", job.ID)
	projection := store.KnowledgeProjection{Entities: []store.KnowledgeEntityRecord{{
		ID: runEntityID, ClassKey: "experiment",
		CanonicalName:  "AnalysisRun " + job.Operation + " (" + job.ID + ")",
		NormalizedName: normalizeKnowledgeName("AnalysisRun " + job.Operation + " " + job.ID),
		Description:    "Deterministically materialized from a verified engineering execution receipt.",
		IdentityKey:    "engineering-job:" + job.ID,
	}}}
	conditions, err := engineeringReceiptConditions(receipt.Spec)
	if err != nil {
		return projection, fmt.Errorf("engineering receipt %s conditions: %w", job.ID, err)
	}
	qualifiers, err := json.Marshal(map[string]any{
		"analysis_run": map[string]any{
			"job_id": job.ID, "operation": job.Operation, "spec_sha256": job.SpecSHA256,
			"tool_component": job.ToolComponent, "tool_version": job.ToolVersion,
		},
		"conditions": conditions,
	})
	if err != nil {
		return projection, err
	}
	for _, key := range keys {
		raw, exists := receipt.Metrics[key]
		if !exists {
			if contracts[key].Optional {
				continue
			}
			return projection, fmt.Errorf("engineering receipt %s omits required metric %q", job.ID, key)
		}
		literal, canonicalValue, err := engineeringMetricLiteral(key, contracts[key], raw)
		if err != nil {
			return projection, fmt.Errorf("engineering receipt %s metric %s: %w", job.ID, key, err)
		}
		literalJSON, err := json.Marshal(literal)
		if err != nil {
			return projection, err
		}
		observationID := engineeringProjectionID("observation", job.ID, key)
		projection.Entities = append(projection.Entities, store.KnowledgeEntityRecord{
			ID: observationID, ClassKey: "measurement",
			CanonicalName:  "Observation " + key + " (" + job.ID + ")",
			NormalizedName: normalizeKnowledgeName("Observation " + key + " " + job.ID),
			Description:    "Scalar solver result retained with its receipt locator and condition set.",
			IdentityKey:    "engineering-observation:" + job.ID + ":" + key,
		})
		pointer := "/metrics/" + escapeEngineeringJSONPointerToken(key)
		valueHash := engineeringProjectionHash(canonicalValue)
		locator, err := json.Marshal(map[string]any{"json_pointer": pointer, "value_hash": valueHash})
		if err != nil {
			return projection, err
		}
		relation := store.KnowledgeAssertionRecord{
			ID: engineeringProjectionID("has-result", job.ID, key), SubjectEntityID: runEntityID,
			PredicateKey: "has_result", ObjectEntityID: observationID, Qualifiers: qualifiers,
			Polarity: "affirmed", Status: "accepted", Confidence: 1,
		}
		relation.AssertionKey = engineeringAssertionKey(relation)
		valueAssertion := store.KnowledgeAssertionRecord{
			ID: engineeringProjectionID("has-value", job.ID, key), SubjectEntityID: observationID,
			PredicateKey: "has_value", Literal: literalJSON, Qualifiers: qualifiers,
			Polarity: "affirmed", Status: "accepted", Confidence: 1,
		}
		valueAssertion.AssertionKey = engineeringAssertionKey(valueAssertion)
		projection.Assertions = append(projection.Assertions, relation, valueAssertion)
		for _, assertionID := range []string{relation.ID, valueAssertion.ID} {
			projection.Evidence = append(projection.Evidence, store.KnowledgeAssertionEvidenceRecord{
				AssertionID: assertionID, EvidenceKind: "artifact_value", BlobHash: receiptArtifact.BlobHash,
				Locator: locator, EvidenceSHA256: valueHash,
			})
		}
	}
	return projection, nil
}

func validateEngineeringArtifactOnlyMetric(value json.RawMessage, kind engineeringArtifactMetricKind) error {
	switch kind {
	case engineeringArtifactMetricArray:
		var decoded []json.RawMessage
		if err := json.Unmarshal(value, &decoded); err != nil {
			return err
		}
	case engineeringArtifactMetricObject:
		var decoded map[string]json.RawMessage
		if err := json.Unmarshal(value, &decoded); err != nil {
			return err
		}
		if decoded == nil {
			return errors.New("null is not an object")
		}
	default:
		return fmt.Errorf("unsupported artifact-only metric kind %q", kind)
	}
	return nil
}

func engineeringReceiptConditions(raw json.RawMessage) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var spec map[string]any
	if err := decoder.Decode(&spec); err != nil || spec == nil {
		return nil, errors.New("canonical spec must be a JSON object")
	}
	arguments, ok := spec["arguments"].(map[string]any)
	if !ok || len(arguments) == 0 {
		return nil, errors.New("canonical spec omits its arguments object")
	}
	conditions := make(map[string]any, len(arguments))
	for key, value := range arguments {
		if key == "run_id" || key == "stage_attempt_id" {
			continue
		}
		conditions[key] = value
	}
	if len(conditions) == 0 {
		return nil, errors.New("canonical spec has no reusable engineering conditions")
	}
	return conditions, nil
}

func engineeringMetricLiteral(
	metric string,
	contract engineeringMetricContract,
	raw json.RawMessage,
) (core.KnowledgeTypedLiteral, []byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return core.KnowledgeTypedLiteral{}, nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("metric contains multiple JSON values")
		}
		return core.KnowledgeTypedLiteral{}, nil, err
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return core.KnowledgeTypedLiteral{}, nil, err
	}
	literal := core.KnowledgeTypedLiteral{}
	switch contract.Kind {
	case engineeringMetricInteger, engineeringMetricDecimal, engineeringMetricAngle, engineeringMetricLength:
		number, ok := value.(json.Number)
		if !ok {
			return literal, nil, errors.New("expected a JSON number")
		}
		lexical := number.String()
		parsed, err := strconv.ParseFloat(lexical, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return literal, nil, errors.New("metric must be a finite decimal")
		}
		literal.LexicalForm = lexical
		switch contract.Kind {
		case engineeringMetricInteger:
			if _, err := strconv.ParseInt(lexical, 10, 64); err != nil {
				return literal, nil, errors.New("metric must be a base-10 integer")
			}
			literal.Datatype = "http://www.w3.org/2001/XMLSchema#integer"
		case engineeringMetricDecimal:
			literal.Datatype = "http://www.w3.org/2001/XMLSchema#decimal"
		case engineeringMetricAngle:
			literal.Datatype = core.KnowledgeDatatypeAngle
			literal.Unit = contract.Unit
			literal.SIUnit = "rad"
			literal.SIValue, err = exactEngineeringDecimalProduct(lexical, "0.017453292519943295")
			if err != nil {
				return literal, nil, err
			}
		case engineeringMetricLength:
			if contract.Unit != "m" {
				return literal, nil, fmt.Errorf("unsupported engineering length unit %q", contract.Unit)
			}
			literal.Datatype = core.KnowledgeDatatypeLength
			literal.Unit = "m"
			literal.SIUnit = "m"
			literal.SIValue = lexical
		}
	case engineeringMetricBoolean:
		booleanValue, ok := value.(bool)
		if !ok {
			return literal, nil, errors.New("expected a JSON boolean")
		}
		literal.LexicalForm = strconv.FormatBool(booleanValue)
		literal.Datatype = "http://www.w3.org/2001/XMLSchema#boolean"
	case engineeringMetricString:
		stringValue, ok := value.(string)
		if !ok || strings.TrimSpace(stringValue) == "" {
			return literal, nil, errors.New("expected a non-empty JSON string")
		}
		if metric == "coherence" && stringValue != "pass" {
			return literal, nil, errors.New("mesh coherence must be pass")
		}
		literal.LexicalForm = stringValue
		literal.Datatype = "http://www.w3.org/2001/XMLSchema#string"
	default:
		return literal, nil, fmt.Errorf("unsupported metric contract %q", contract.Kind)
	}
	if err := literal.Validate(); err != nil {
		return core.KnowledgeTypedLiteral{}, nil, err
	}
	return literal, canonical, nil
}

func exactEngineeringDecimalProduct(left, right string) (string, error) {
	a, ok := new(big.Rat).SetString(left)
	if !ok {
		return "", fmt.Errorf("%q is not an exact decimal", left)
	}
	b, ok := new(big.Rat).SetString(right)
	if !ok {
		return "", fmt.Errorf("%q is not an exact conversion factor", right)
	}
	value := new(big.Rat).Mul(a, b)
	encoded := value.FloatString(48)
	encoded = strings.TrimRight(strings.TrimRight(encoded, "0"), ".")
	if encoded == "-0" || encoded == "" {
		encoded = "0"
	}
	return encoded, nil
}

func engineeringProjectionID(parts ...string) string {
	return "keng_" + engineeringProjectionHash([]byte(strings.Join(parts, "\x00")))[:32]
}

func engineeringAssertionKey(assertion store.KnowledgeAssertionRecord) string {
	return engineeringProjectionHash([]byte(strings.Join([]string{
		assertion.SubjectEntityID, assertion.PredicateKey, assertion.ObjectEntityID,
		string(assertion.Literal), string(assertion.Qualifiers),
	}, "\x00")))
}

func engineeringProjectionHash(value []byte) string { return hashBytes(value) }

func escapeEngineeringJSONPointerToken(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}
