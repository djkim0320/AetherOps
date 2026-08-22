package research

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

var stageCapabilityIdentityPattern = regexp.MustCompile(`(?i)(?:\brun_id\b|\bstage_attempt_id\b|\brun_[0-9a-f]{16,}\b|\bstg_[0-9a-f]{16,}\b)`)

const canonicalEvidenceClaimPrefix = "ecl_"

var canonicalEvidenceClaimIDPattern = regexp.MustCompile(`^ecl_[a-f0-9]{64}$`)

type ontologyPatchTerm struct {
	Key       string `json:"term_key"`
	Kind      string `json:"kind"`
	ValueKind string `json:"value_kind,omitempty"`
}

type ontologyPatchContract struct {
	OntologyID string              `json:"ontology_id"`
	Classes    []ontologyPatchTerm `json:"classes"`
	Properties []ontologyPatchTerm `json:"properties"`
}

func loadRunOntologyPatchContract(ctx context.Context, database *store.DB, runID string) (ontologyPatchContract, error) {
	var contract ontologyPatchContract
	var headStatus, generationState string
	if err := database.SQL().QueryRowContext(ctx, `
SELECT g.ontology_id,h.status,g.state
FROM runs r
JOIN project_knowledge_heads h ON h.project_id=r.project_id
JOIN knowledge_generations g ON g.project_id=h.project_id AND g.id=h.generation_id
WHERE r.id=?`, runID).Scan(&contract.OntologyID, &headStatus, &generationState); err != nil {
		return contract, fmt.Errorf("load run ontology contract: %w", err)
	}
	if headStatus != string(store.KnowledgeHeadReady) || generationState != string(store.KnowledgeReady) {
		return contract, fmt.Errorf("run ontology contract is not ready: %s/%s", headStatus, generationState)
	}
	rows, err := database.SQL().QueryContext(ctx, `
SELECT term_key,kind,value_kind
FROM ontology_terms t
WHERE t.ontology_id=? OR (
  t.ontology_id IN(SELECT imported_ontology_id FROM ontology_imports WHERE ontology_id=?)
  AND NOT EXISTS(SELECT 1 FROM ontology_terms own WHERE own.ontology_id=? AND own.term_key=t.term_key)
)
ORDER BY term_key`, contract.OntologyID, contract.OntologyID, contract.OntologyID)
	if err != nil {
		return contract, err
	}
	defer rows.Close()
	for rows.Next() {
		var term ontologyPatchTerm
		if err := rows.Scan(&term.Key, &term.Kind, &term.ValueKind); err != nil {
			return contract, err
		}
		switch term.Kind {
		case "class":
			contract.Classes = append(contract.Classes, term)
		case "object_property", "datatype_property":
			contract.Properties = append(contract.Properties, term)
		}
	}
	if err := rows.Err(); err != nil {
		return contract, err
	}
	if len(contract.Classes) == 0 || len(contract.Properties) == 0 {
		return contract, errors.New("run ontology contract has no usable classes or properties")
	}
	return contract, nil
}

func validateKnowledgePatchOntologyContract(patch core.KnowledgePatch, contract ontologyPatchContract) error {
	classes := make(map[string]struct{}, len(contract.Classes))
	properties := make(map[string]ontologyPatchTerm, len(contract.Properties))
	for _, term := range contract.Classes {
		classes[term.Key] = struct{}{}
	}
	for _, term := range contract.Properties {
		properties[term.Key] = term
	}
	for _, entity := range patch.Entities {
		if _, exists := classes[entity.Type]; !exists {
			return fmt.Errorf("entity %s references unsupported ontology class %q", entity.ID, entity.Type)
		}
	}
	validateProperty := func(key string, entityValue bool) error {
		term, exists := properties[key]
		if !exists {
			return fmt.Errorf("unsupported ontology property %q", key)
		}
		if entityValue && (term.Kind != "object_property" || term.ValueKind != "entity") {
			return fmt.Errorf("ontology property %q does not accept entity values", key)
		}
		if !entityValue && (term.Kind != "datatype_property" || term.ValueKind == "entity") {
			return fmt.Errorf("ontology property %q does not accept literal values", key)
		}
		return nil
	}
	for _, assertion := range patch.Assertions {
		if err := validateProperty(assertion.Predicate, assertion.ObjectEntityID != ""); err != nil {
			return fmt.Errorf("assertion %s: %w", assertion.ID, err)
		}
		for _, qualifier := range assertion.Qualifiers {
			if err := validateProperty(qualifier.Predicate, qualifier.EntityID != ""); err != nil {
				return fmt.Errorf("assertion %s qualifier: %w", assertion.ID, err)
			}
		}
	}
	return nil
}

func (engine *Engine) verifyKnowledgePatchOntology(ctx context.Context, runID string, patch core.KnowledgePatch) error {
	contract, err := loadRunOntologyPatchContract(ctx, engine.db, runID)
	if err != nil {
		return err
	}
	return validateKnowledgePatchOntologyContract(patch, contract)
}

// decodeStrict rejects unknown fields and trailing JSON values. The remote
// protocol receives a fixed JSON Schema, while this check makes the durable
// boundary fail closed even if an adapter returns unchecked bytes.
func decodeStrict[T any](raw json.RawMessage) (T, error) {
	var value T
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return value, errors.New("response contains multiple JSON values")
		}
		return value, err
	}
	return value, nil
}

func validateResearchPlan(plan core.ResearchPlan) error {
	if plan.Workstreams == nil || plan.SourceRequirements == nil || plan.AcceptanceCriteria == nil {
		return errors.New("research plan omits a required array field")
	}
	return plan.Validate()
}

// collectorEvidenceOutput is the untrusted model-facing COLLECT contract.
// Public captures carry their complete evidence_capture metadata, while an
// engineering result is represented only by its opaque receipt artifact id.
// The latter is resolved to a canonical EvidenceSource from SQLite/CAS before
// a core.EvidenceBundle is validated or persisted.
type collectorEvidenceOutput struct {
	WorkstreamID                  string                `json:"workstream_id"`
	Summary                       string                `json:"summary"`
	Claims                        []core.EvidenceClaim  `json:"claims"`
	Sources                       []core.EvidenceSource `json:"sources"`
	EngineeringReceiptArtifactIDs []string              `json:"engineering_receipt_artifact_ids"`
	Limitations                   []string              `json:"limitations"`
}

func validateCollectorEvidenceOutput(output collectorEvidenceOutput, expectedWorkstreamID string) error {
	if strings.TrimSpace(output.WorkstreamID) == "" {
		return errors.New("evidence workstream id is required")
	}
	if expectedWorkstreamID != "" && output.WorkstreamID != expectedWorkstreamID {
		return fmt.Errorf("evidence workstream is %q, want %q", output.WorkstreamID, expectedWorkstreamID)
	}
	if strings.TrimSpace(output.Summary) == "" {
		return errors.New("evidence summary is required")
	}
	if output.Claims == nil || output.Sources == nil || output.EngineeringReceiptArtifactIDs == nil || output.Limitations == nil {
		return errors.New("collector evidence output omits a required array field")
	}
	if len(output.Sources)+len(output.EngineeringReceiptArtifactIDs) == 0 {
		return errors.New("collector evidence output requires a captured public source or engineering receipt artifact id")
	}

	sourceIDs := make(map[string]struct{}, len(output.Sources)+len(output.EngineeringReceiptArtifactIDs))
	for _, source := range output.Sources {
		if _, receiptSource := core.EngineeringReceiptArtifactID(source); receiptSource {
			return fmt.Errorf("engineering receipt %q must be referenced only through engineering_receipt_artifact_ids", source.ID)
		}
		if err := source.Validate(); err != nil {
			return err
		}
		if _, duplicate := sourceIDs[source.ID]; duplicate {
			return fmt.Errorf("duplicate evidence source id %q", source.ID)
		}
		sourceIDs[source.ID] = struct{}{}
	}
	for _, artifactID := range output.EngineeringReceiptArtifactIDs {
		if !core.IsEngineeringReceiptArtifactID(artifactID) {
			return fmt.Errorf("engineering receipt artifact id %q is invalid", artifactID)
		}
		if _, duplicate := sourceIDs[artifactID]; duplicate {
			return fmt.Errorf("duplicate evidence source id %q", artifactID)
		}
		sourceIDs[artifactID] = struct{}{}
	}

	claimIDs := make(map[string]struct{}, len(output.Claims))
	for _, claim := range output.Claims {
		if strings.TrimSpace(claim.ID) == "" || strings.TrimSpace(claim.Statement) == "" {
			return errors.New("evidence claim id and statement are required")
		}
		// ecl_ is minted only after the complete untrusted bundle has passed
		// its internal source/claim validation. Rejecting the reserved namespace
		// here lets the trusted canonicalizer be idempotent without allowing a
		// model to smuggle a pre-canonicalized or cross-workstream identity in.
		if strings.HasPrefix(claim.ID, canonicalEvidenceClaimPrefix) {
			return fmt.Errorf("evidence claim id %q uses the reserved canonical namespace", claim.ID)
		}
		if _, duplicate := claimIDs[claim.ID]; duplicate {
			return fmt.Errorf("duplicate evidence claim id %q", claim.ID)
		}
		claimIDs[claim.ID] = struct{}{}
		if len(claim.SourceIDs) == 0 {
			return fmt.Errorf("evidence claim %q has no source ids", claim.ID)
		}
		for _, sourceID := range claim.SourceIDs {
			if _, exists := sourceIDs[sourceID]; !exists {
				return fmt.Errorf("evidence claim %q references unknown source %q", claim.ID, sourceID)
			}
		}
	}
	return nil
}

// canonicalizeEvidenceClaimIDs is the one trusted transition from a
// model-local claim namespace to the durable run-wide namespace. Source IDs
// deliberately remain unchanged: they are core-minted evidence-capture or
// engineering-artifact handles whose exact values are resolved against the
// run/stage-owned SQLite rows and CAS bytes. Rewriting those handles would
// sever that provenance binding rather than improve identity isolation.
func canonicalizeEvidenceClaimIDs(runID string, bundle core.EvidenceBundle) (core.EvidenceBundle, error) {
	if strings.TrimSpace(runID) == "" {
		return core.EvidenceBundle{}, errors.New("cannot canonicalize claims without a run id")
	}
	if strings.TrimSpace(bundle.WorkstreamID) == "" {
		return core.EvidenceBundle{}, errors.New("cannot canonicalize claims without a workstream id")
	}
	canonical := bundle
	canonical.Claims = make([]core.EvidenceClaim, len(bundle.Claims))
	for index, claim := range bundle.Claims {
		canonical.Claims[index] = claim
		canonical.Claims[index].SourceIDs = append([]string(nil), claim.SourceIDs...)
		if canonicalEvidenceClaimIDPattern.MatchString(claim.ID) {
			// Canonical artifacts are read back verbatim on restart. Keeping an
			// already trusted ID stable avoids a hash-of-a-hash identity change.
			continue
		}
		if strings.HasPrefix(claim.ID, canonicalEvidenceClaimPrefix) {
			return core.EvidenceBundle{}, fmt.Errorf("claim id %q is an invalid canonical evidence id", claim.ID)
		}
		digest := sha256.Sum256([]byte(runID + "\x00" + bundle.WorkstreamID + "\x00" + claim.ID))
		canonical.Claims[index].ID = canonicalEvidenceClaimPrefix + hex.EncodeToString(digest[:])
	}
	return canonical, nil
}

// validateGlobalEvidenceIdentity fails before SYNTHESIZE whenever a completed
// collector set contains a legacy/non-canonical claim or any identity that is
// ambiguous across workstreams. ReportManifest.Validate retains the same
// checks as a second, report-bound line of defense.
func validateGlobalEvidenceIdentity(evidence []core.EvidenceBundle) error {
	workstreamIDs := make(map[string]struct{}, len(evidence))
	sourceIDs := make(map[string]string)
	claimIDs := make(map[string]string)
	for _, bundle := range evidence {
		if err := validateEvidenceBundle(bundle, bundle.WorkstreamID); err != nil {
			return err
		}
		if _, duplicate := workstreamIDs[bundle.WorkstreamID]; duplicate {
			return fmt.Errorf("duplicate evidence workstream id %q", bundle.WorkstreamID)
		}
		workstreamIDs[bundle.WorkstreamID] = struct{}{}
		for _, source := range bundle.Sources {
			if owner, duplicate := sourceIDs[source.ID]; duplicate {
				return fmt.Errorf("duplicate evidence source id %q across workstreams %q and %q", source.ID, owner, bundle.WorkstreamID)
			}
			sourceIDs[source.ID] = bundle.WorkstreamID
		}
		for _, claim := range bundle.Claims {
			if !canonicalEvidenceClaimIDPattern.MatchString(claim.ID) {
				return fmt.Errorf("evidence claim id %q in workstream %q is not canonical", claim.ID, bundle.WorkstreamID)
			}
			if owner, duplicate := claimIDs[claim.ID]; duplicate {
				return fmt.Errorf("duplicate evidence claim id %q across workstreams %q and %q", claim.ID, owner, bundle.WorkstreamID)
			}
			claimIDs[claim.ID] = bundle.WorkstreamID
		}
	}
	return nil
}

func (output collectorEvidenceOutput) canonicalBundle(sources []core.EvidenceSource) core.EvidenceBundle {
	claims := make([]core.EvidenceClaim, len(output.Claims))
	copy(claims, output.Claims)
	canonicalSources := make([]core.EvidenceSource, len(sources))
	copy(canonicalSources, sources)
	limitations := make([]string, len(output.Limitations))
	copy(limitations, output.Limitations)
	return core.EvidenceBundle{
		WorkstreamID: output.WorkstreamID,
		Summary:      output.Summary,
		Claims:       claims,
		Sources:      canonicalSources,
		Limitations:  limitations,
	}
}

// stripStageCapabilityIdentity keeps ephemeral run/stage capability values out
// of the durable research contract. Each later stage receives fresh IDs in its
// own immutable prompt envelope; retaining a PLAN attempt ID here can make an
// otherwise isolated collector call tools with authority from the wrong stage.
func stripStageCapabilityIdentity(plan core.ResearchPlan) (core.ResearchPlan, error) {
	if stageCapabilityIdentityPattern.MatchString(plan.Mode) {
		return core.ResearchPlan{}, errors.New("research plan mode contains stage capability identity")
	}
	filter := func(values []string) []string {
		filtered := make([]string, 0, len(values))
		for _, value := range values {
			if !stageCapabilityIdentityPattern.MatchString(value) {
				filtered = append(filtered, value)
			}
		}
		return filtered
	}
	for index := range plan.Workstreams {
		workstream := &plan.Workstreams[index]
		if stageCapabilityIdentityPattern.MatchString(workstream.ID) || stageCapabilityIdentityPattern.MatchString(workstream.Question) {
			return core.ResearchPlan{}, fmt.Errorf("workstream %d contains stage capability identity", index)
		}
		workstream.PreferredSourceKinds = filter(workstream.PreferredSourceKinds)
		workstream.RequiredEvidence = filter(workstream.RequiredEvidence)
	}
	plan.SourceRequirements = filter(plan.SourceRequirements)
	plan.AcceptanceCriteria = filter(plan.AcceptanceCriteria)
	return plan, nil
}

func validateEvidenceBundle(bundle core.EvidenceBundle, expectedWorkstreamID string) error {
	if strings.TrimSpace(bundle.WorkstreamID) == "" {
		return errors.New("evidence workstream id is required")
	}
	if expectedWorkstreamID != "" && bundle.WorkstreamID != expectedWorkstreamID {
		return fmt.Errorf("evidence workstream is %q, want %q", bundle.WorkstreamID, expectedWorkstreamID)
	}
	if strings.TrimSpace(bundle.Summary) == "" {
		return errors.New("evidence summary is required")
	}
	if bundle.Claims == nil || bundle.Sources == nil || bundle.Limitations == nil {
		return errors.New("evidence bundle omits a required array field")
	}

	sourceIDs := make(map[string]struct{}, len(bundle.Sources))
	for _, source := range bundle.Sources {
		if strings.TrimSpace(source.ID) == "" || strings.TrimSpace(source.Title) == "" {
			return errors.New("evidence source id and title are required")
		}
		// Public evidence must retain the canonical HTTP(S) URL returned by
		// evidence_capture. Engineering evidence has no external URL: its
		// locator is the closed receipt URN minted by AetherOps and later bound
		// to a succeeded, run-owned CAS artifact by verifyEvidenceSources.
		if _, receiptSource := core.EngineeringReceiptArtifactID(source); !receiptSource {
			parsed, err := url.Parse(source.URL)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
				return fmt.Errorf("evidence source %q must use a captured public HTTP(S) URL or the exact provenance receipt URN returned by a succeeded AetherOps engineering call; a denied or failed tool call is not evidence", source.ID)
			}
		}
		if source.CapturedAt.Before(time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)) {
			return fmt.Errorf("evidence source %q has an invalid capture time", source.ID)
		}
		if strings.TrimSpace(source.BlobHash) == "" {
			return fmt.Errorf("evidence source %q is missing its blob hash", source.ID)
		}
		if source.BlobHash == strings.Repeat("0", 64) {
			return fmt.Errorf("evidence source %q has a placeholder blob hash", source.ID)
		}
		if _, duplicate := sourceIDs[source.ID]; duplicate {
			return fmt.Errorf("duplicate evidence source id %q", source.ID)
		}
		sourceIDs[source.ID] = struct{}{}
	}

	claimIDs := make(map[string]struct{}, len(bundle.Claims))
	for _, claim := range bundle.Claims {
		if strings.TrimSpace(claim.ID) == "" || strings.TrimSpace(claim.Statement) == "" {
			return errors.New("evidence claim id and statement are required")
		}
		if _, duplicate := claimIDs[claim.ID]; duplicate {
			return fmt.Errorf("duplicate evidence claim id %q", claim.ID)
		}
		claimIDs[claim.ID] = struct{}{}
		if len(claim.SourceIDs) == 0 {
			return fmt.Errorf("evidence claim %q has no source ids", claim.ID)
		}
		for _, sourceID := range claim.SourceIDs {
			if _, exists := sourceIDs[sourceID]; !exists {
				return fmt.Errorf("evidence claim %q references unknown source %q", claim.ID, sourceID)
			}
		}
	}
	return nil
}

func validateReportManifest(report core.ReportManifest) error {
	if strings.TrimSpace(report.Title) == "" || strings.TrimSpace(report.AnswerMarkdown) == "" {
		return errors.New("report title and answer markdown are required")
	}
	if report.Citations == nil || report.EvidenceIDs == nil || report.ArtifactHashes == nil || report.Uncertainties == nil {
		return errors.New("report omits a required array field")
	}
	markers := make(map[string]struct{}, len(report.Citations))
	for _, citation := range report.Citations {
		if strings.TrimSpace(citation.Marker) == "" {
			return errors.New("report citation marker is required")
		}
		if _, duplicate := markers[citation.Marker]; duplicate {
			return fmt.Errorf("duplicate report citation marker %q", citation.Marker)
		}
		markers[citation.Marker] = struct{}{}
		if len(citation.SourceIDs) == 0 || len(citation.ClaimIDs) == 0 {
			return fmt.Errorf("report citation %q must include source and claim ids", citation.Marker)
		}
		for _, sourceID := range citation.SourceIDs {
			if strings.TrimSpace(sourceID) == "" {
				return fmt.Errorf("report citation %q has an empty source id", citation.Marker)
			}
		}
		for _, claimID := range citation.ClaimIDs {
			if strings.TrimSpace(claimID) == "" {
				return fmt.Errorf("report citation %q has an empty claim id", citation.Marker)
			}
		}
	}
	for _, hash := range report.ArtifactHashes {
		if strings.TrimSpace(hash) == "" {
			return errors.New("report artifact hashes cannot contain empty values")
		}
	}
	if err := report.KnowledgePatch.ValidateStructure(); err != nil {
		return fmt.Errorf("validate report knowledge patch: %w", err)
	}
	if report.EngineeringAssessment != nil {
		if err := report.EngineeringAssessment.Validate(); err != nil {
			return fmt.Errorf("validate report engineering assessment: %w", err)
		}
	}
	return nil
}

func validateReviewVerdict(verdict core.ReviewVerdict) error {
	if verdict.CriticalErrors == nil || verdict.RevisionRequests == nil {
		return errors.New("review verdict omits a required array field")
	}
	_, err := verdict.Passes()
	return err
}

func validateReviewVerdictForReport(verdict core.ReviewVerdict, report core.ReportManifest) error {
	if err := validateReviewVerdict(verdict); err != nil {
		return err
	}
	if verdict.KnowledgeIntegrity.UnsupportedAssertions > len(report.KnowledgePatch.Assertions) {
		return fmt.Errorf("review reports %d unsupported assertions but patch contains %d", verdict.KnowledgeIntegrity.UnsupportedAssertions, len(report.KnowledgePatch.Assertions))
	}
	return nil
}

// verifyKnowledgePatchEvidence performs the cryptographic readback that cannot
// be delegated to the reviewing model. ReportManifest.Validate has already
// bound every handle to collected evidence or a report-owned artifact.
func (engine *Engine) verifyKnowledgePatchEvidence(ctx context.Context, runID string, report core.ReportManifest) error {
	return VerifyKnowledgePatchEvidence(ctx, engine.db, engine.cas, runID, report)
}

// VerifyKnowledgePatchEvidence repeats the same cryptographic evidence
// readback used by the live research engine. It is exported for the offline
// release gate so a stored passing verdict cannot replace CAS verification.
func VerifyKnowledgePatchEvidence(
	ctx context.Context,
	database *store.DB,
	objectsStore *cas.Store,
	runID string,
	report core.ReportManifest,
) error {
	if database == nil || objectsStore == nil || strings.TrimSpace(runID) == "" {
		return errors.New("knowledge evidence verification requires database, CAS, and run")
	}
	objects := make(map[string][]byte)
	readObject := func(hash string) ([]byte, error) {
		if data, exists := objects[hash]; exists {
			return data, nil
		}
		data, err := objectsStore.ReadVerified(hash)
		if err != nil {
			return nil, err
		}
		objects[hash] = data
		return data, nil
	}

	var engineeringArtifacts map[string]struct{}
	for _, assertion := range report.KnowledgePatch.Assertions {
		for _, reference := range assertion.Evidence {
			if err := ctx.Err(); err != nil {
				return err
			}
			switch reference.Kind {
			case core.KnowledgeEvidenceText:
				data, err := readObject(reference.BlobHash)
				if err != nil {
					return fmt.Errorf("read text evidence for knowledge assertion %q: %w", assertion.ID, err)
				}
				if !utf8.Valid(data) || reference.ByteStart < 0 || reference.ByteEnd <= reference.ByteStart ||
					reference.ByteStart > int64(len(data)) || reference.ByteEnd > int64(len(data)) {
					return fmt.Errorf("knowledge assertion %q has an invalid UTF-8 byte span", assertion.ID)
				}
				span := data[int(reference.ByteStart):int(reference.ByteEnd)]
				if !utf8.Valid(span) || sha256Hex(span) != reference.SpanHash {
					return fmt.Errorf("knowledge assertion %q text span hash does not match CAS", assertion.ID)
				}
			case core.KnowledgeEvidenceEngineering:
				if engineeringArtifacts == nil {
					results, err := database.ListRunEngineeringResults(ctx, runID)
					if err != nil {
						return fmt.Errorf("load engineering evidence for knowledge patch: %w", err)
					}
					engineeringArtifacts = make(map[string]struct{})
					for _, result := range results {
						for _, artifact := range result.Artifacts {
							engineeringArtifacts[artifact.BlobHash] = struct{}{}
						}
					}
				}
				if _, exists := engineeringArtifacts[reference.ArtifactHash]; !exists {
					return fmt.Errorf("knowledge assertion %q does not reference a successful engineering result", assertion.ID)
				}
				data, err := readObject(reference.ArtifactHash)
				if err != nil {
					return fmt.Errorf("read engineering evidence for knowledge assertion %q: %w", assertion.ID, err)
				}
				value, err := engineeringEvidenceValue(data, reference)
				if err != nil {
					return fmt.Errorf("locate engineering evidence for knowledge assertion %q: %w", assertion.ID, err)
				}
				canonical, err := json.Marshal(value)
				if err != nil {
					return fmt.Errorf("encode engineering evidence for knowledge assertion %q: %w", assertion.ID, err)
				}
				if sha256Hex(canonical) != reference.ValueHash {
					return fmt.Errorf("knowledge assertion %q engineering value hash does not match CAS", assertion.ID)
				}
			default:
				return fmt.Errorf("knowledge assertion %q has unsupported evidence kind %q", assertion.ID, reference.Kind)
			}
		}
	}
	return nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func engineeringEvidenceValue(data []byte, reference core.KnowledgeEvidenceRef) (any, error) {
	if reference.JSONPointer != "" {
		return jsonPointerValue(data, reference.JSONPointer)
	}
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	for row := int64(1); ; row++ {
		record, err := reader.Read()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("CSV row %d does not exist", reference.CSVRow)
		}
		if err != nil {
			return nil, fmt.Errorf("parse CSV row %d: %w", row, err)
		}
		if row == reference.CSVRow {
			return record, nil
		}
	}
}

func jsonPointerValue(data []byte, pointer string) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode JSON artifact: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("JSON artifact contains multiple values")
		}
		return nil, err
	}
	for _, rawToken := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		token, err := decodeJSONPointerToken(rawToken)
		if err != nil {
			return nil, err
		}
		switch current := value.(type) {
		case map[string]any:
			var exists bool
			value, exists = current[token]
			if !exists {
				return nil, fmt.Errorf("JSON pointer member %q does not exist", token)
			}
		case []any:
			if token == "" || (len(token) > 1 && token[0] == '0') {
				return nil, fmt.Errorf("JSON pointer array index %q is invalid", token)
			}
			index, err := strconv.Atoi(token)
			if err != nil || index < 0 || index >= len(current) {
				return nil, fmt.Errorf("JSON pointer array index %q is outside the artifact", token)
			}
			value = current[index]
		default:
			return nil, fmt.Errorf("JSON pointer cannot traverse %q", token)
		}
	}
	return value, nil
}

func decodeJSONPointerToken(token string) (string, error) {
	var decoded strings.Builder
	for index := 0; index < len(token); index++ {
		if token[index] != '~' {
			decoded.WriteByte(token[index])
			continue
		}
		if index+1 >= len(token) {
			return "", errors.New("JSON pointer contains an incomplete escape")
		}
		index++
		switch token[index] {
		case '0':
			decoded.WriteByte('~')
		case '1':
			decoded.WriteByte('/')
		default:
			return "", errors.New("JSON pointer contains an invalid escape")
		}
	}
	return decoded.String(), nil
}
