package knowledge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/cas"
	"github.com/djkim0320/Aether-claw/internal/core"
	"github.com/djkim0320/Aether-claw/internal/store"
)

const (
	identityGoldSchemaV1     = "aetherops-knowledge-identity-gold-v1"
	evidenceSpanGoldSchemaV1 = "aetherops-knowledge-evidence-span-gold-v1"
	requiredMergePrecision   = 99.0
	requiredSpanAccuracy     = 98.0
)

type knowledgeNormalizationGoldCase struct {
	ID       string `json:"id"`
	Input    string `json:"input"`
	Expected string `json:"expected"`
}

type knowledgeExistingIdentityGold struct {
	ID            string                `json:"id"`
	ClassKey      string                `json:"class_key"`
	CanonicalName string                `json:"canonical_name"`
	Aliases       []core.KnowledgeAlias `json:"aliases"`
}

type knowledgeIdentityGoldCase struct {
	ID               string                          `json:"id"`
	ExistingEntities []knowledgeExistingIdentityGold `json:"existing_entities"`
	Incoming         core.KnowledgeEntity            `json:"incoming"`
	ExpectedDecision string                          `json:"expected_decision"`
	ExpectedEntityID string                          `json:"expected_entity_id"`
}

type knowledgeIdentityGoldFixture struct {
	SchemaVersion           string                           `json:"schema_version"`
	MinimumPrecisionPercent float64                          `json:"minimum_precision_percent"`
	NormalizationCases      []knowledgeNormalizationGoldCase `json:"normalization_cases"`
	IdentityCases           []knowledgeIdentityGoldCase      `json:"identity_cases"`
}

type knowledgeEvidenceSegmentGold struct {
	Text   string `json:"text"`
	Repeat int    `json:"repeat"`
}

type knowledgeEvidenceSpanGoldCase struct {
	ID                    string                         `json:"id"`
	RawText               string                         `json:"raw_text"`
	Segments              []knowledgeEvidenceSegmentGold `json:"segments"`
	Excerpt               string                         `json:"excerpt"`
	ByteStart             int                            `json:"byte_start"`
	ByteEnd               int                            `json:"byte_end"`
	SpanSHA256            string                         `json:"span_sha256"`
	ExpectedChunkOrdinal  int                            `json:"expected_chunk_ordinal"`
	ExpectedDecision      string                         `json:"expected_decision"`
	ExpectedErrorContains string                         `json:"expected_error_contains"`
}

type knowledgeEvidenceSpanGoldFixture struct {
	SchemaVersion          string                          `json:"schema_version"`
	MinimumAccuracyPercent float64                         `json:"minimum_accuracy_percent"`
	Cases                  []knowledgeEvidenceSpanGoldCase `json:"cases"`
}

func TestKnowledgeIdentityGoldPrecision(t *testing.T) {
	fixture := loadKnowledgeGoldFixture[knowledgeIdentityGoldFixture](t, "identity-merge-gold-v1.json")
	if fixture.SchemaVersion != identityGoldSchemaV1 {
		t.Fatalf("identity gold schema = %q, want %q", fixture.SchemaVersion, identityGoldSchemaV1)
	}
	if fixture.MinimumPrecisionPercent < requiredMergePrecision {
		t.Fatalf("identity gold threshold %.2f%% is below required %.2f%%", fixture.MinimumPrecisionPercent, requiredMergePrecision)
	}
	if len(fixture.NormalizationCases) == 0 || len(fixture.IdentityCases) < 20 {
		t.Fatalf("identity gold fixture must contain normalization cases and at least 20 decisions; got %d decisions", len(fixture.IdentityCases))
	}
	normalizationIDs := make(map[string]bool, len(fixture.NormalizationCases))
	for _, gold := range fixture.NormalizationCases {
		if gold.ID == "" || normalizationIDs[gold.ID] {
			t.Fatalf("identity normalization gold contains an empty or duplicate id %q", gold.ID)
		}
		normalizationIDs[gold.ID] = true
		if actual := normalizeKnowledgeName(gold.Input); actual != gold.Expected {
			t.Errorf("normalization %s = %q, want %q", gold.ID, actual, gold.Expected)
		}
	}

	ctx := context.Background()
	database, _ := openKnowledgeServiceTestStorage(t)
	service := &Service{DB: database}
	truePositive, falsePositive, expectedPositive := 0, 0, 0
	identityIDs := make(map[string]bool, len(fixture.IdentityCases))
	for _, gold := range fixture.IdentityCases {
		if gold.ID == "" || identityIDs[gold.ID] {
			t.Fatalf("identity decision gold contains an empty or duplicate id %q", gold.ID)
		}
		identityIDs[gold.ID] = true
		project, err := database.CreateProject(ctx, "identity gold "+gold.ID)
		if err != nil {
			t.Fatalf("case %s create project: %v", gold.ID, err)
		}
		generation, err := database.CreateKnowledgeGeneration(ctx, project.ID, store.CoreOntologyID, store.CoreOntologyContractSHA256)
		if err != nil {
			t.Fatalf("case %s create generation: %v", gold.ID, err)
		}
		projection := store.KnowledgeProjection{}
		existingIDs := make(map[string]bool, len(gold.ExistingEntities))
		for _, existing := range gold.ExistingEntities {
			existingIDs[existing.ID] = true
			projection.Entities = append(projection.Entities, store.KnowledgeEntityRecord{
				ID: existing.ID, ClassKey: existing.ClassKey, CanonicalName: existing.CanonicalName,
				NormalizedName: normalizeKnowledgeName(existing.CanonicalName),
			})
			for _, alias := range existing.Aliases {
				projection.Aliases = append(projection.Aliases, store.KnowledgeAliasRecord{
					EntityID: existing.ID, Alias: alias.Value,
					NormalizedAlias: normalizeKnowledgeName(alias.Value), Language: alias.Language,
				})
			}
		}
		if err := database.AppendKnowledgeProjection(ctx, project.ID, generation.ID, projection); err != nil {
			t.Fatalf("case %s seed identities: %v", gold.ID, err)
		}
		patch := core.KnowledgePatch{
			SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
			Entities: []core.KnowledgeEntity{gold.Incoming}, Assertions: []core.KnowledgeAssertion{},
		}
		normalized, normalizeErr := service.normalizePinnedPatch(ctx, project.ID, generation.ID, patch)
		actualDecision, actualEntityID := "reject", ""
		if normalizeErr == nil {
			actualDecision = "no_merge"
			if len(normalized.Entities) != 1 {
				t.Errorf("case %s returned %d normalized entities, want 1", gold.ID, len(normalized.Entities))
			}
			for _, entity := range normalized.Entities {
				if existingIDs[entity.ID] {
					actualDecision, actualEntityID = "merge", entity.ID
				}
			}
		}
		if gold.ExpectedDecision == "merge" {
			expectedPositive++
		}
		if actualDecision == "merge" {
			if gold.ExpectedDecision == "merge" {
				truePositive++
			} else {
				falsePositive++
			}
		}
		if actualDecision != gold.ExpectedDecision {
			t.Errorf("case %s decision = %s (err=%v), want %s", gold.ID, actualDecision, normalizeErr, gold.ExpectedDecision)
			continue
		}
		if actualDecision == "merge" && actualEntityID != gold.ExpectedEntityID {
			t.Errorf("case %s merged to %q, want %q", gold.ID, actualEntityID, gold.ExpectedEntityID)
		}
	}
	if expectedPositive == 0 || truePositive+falsePositive == 0 {
		t.Fatal("identity gold fixture does not exercise an automatic merge")
	}
	precision := 100 * float64(truePositive) / float64(truePositive+falsePositive)
	t.Logf("auto-merge precision %.2f%% (TP=%d FP=%d expected-positive=%d)", precision, truePositive, falsePositive, expectedPositive)
	if precision < requiredMergePrecision || precision < fixture.MinimumPrecisionPercent {
		t.Fatalf("auto-merge precision %.2f%% is below required %.2f%%", precision, max(requiredMergePrecision, fixture.MinimumPrecisionPercent))
	}
}

func TestKnowledgeEvidenceSpanGoldAccuracy(t *testing.T) {
	fixture := loadKnowledgeGoldFixture[knowledgeEvidenceSpanGoldFixture](t, "evidence-span-gold-v1.json")
	if fixture.SchemaVersion != evidenceSpanGoldSchemaV1 {
		t.Fatalf("evidence span gold schema = %q, want %q", fixture.SchemaVersion, evidenceSpanGoldSchemaV1)
	}
	if fixture.MinimumAccuracyPercent < requiredSpanAccuracy {
		t.Fatalf("evidence span threshold %.2f%% is below required %.2f%%", fixture.MinimumAccuracyPercent, requiredSpanAccuracy)
	}
	if len(fixture.Cases) < 20 {
		t.Fatalf("evidence span gold fixture must contain at least 20 cases; got %d", len(fixture.Cases))
	}
	objects, err := cas.Open(filepath.Join(t.TempDir(), "objects"))
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{CAS: objects}
	correct := 0
	caseIDs := make(map[string]bool, len(fixture.Cases))
	for _, gold := range fixture.Cases {
		if gold.ID == "" || caseIDs[gold.ID] {
			t.Fatalf("evidence span gold contains an empty or duplicate id %q", gold.ID)
		}
		caseIDs[gold.ID] = true
		raw, err := materializeKnowledgeGoldText(gold)
		if err != nil {
			t.Errorf("case %s fixture: %v", gold.ID, err)
			continue
		}
		if gold.ByteStart < 0 || gold.ByteEnd <= gold.ByteStart || gold.ByteEnd > len(raw) {
			t.Errorf("case %s has invalid gold byte range [%d,%d) for %d bytes", gold.ID, gold.ByteStart, gold.ByteEnd, len(raw))
			continue
		}
		goldSpan := raw[gold.ByteStart:gold.ByteEnd]
		if string(goldSpan) != gold.Excerpt || hashBytes(goldSpan) != gold.SpanSHA256 {
			t.Errorf("case %s fixture span/hash does not bind the expected excerpt", gold.ID)
			continue
		}
		receipt, err := objects.PutBytes(raw)
		if err != nil {
			t.Errorf("case %s CAS write: %v", gold.ID, err)
			continue
		}
		normalized, _, err := normalizedDocumentWithBoundaries(raw)
		if err != nil {
			t.Errorf("case %s normalize source: %v", gold.ID, err)
			continue
		}
		windows := deterministicChunkWindows(normalized)
		document := adoptedRunDocument{ID: "gold-document-" + gold.ID, BlobHash: receipt.Hash}
		for _, window := range windows {
			document.Chunks = append(document.Chunks, adoptedRunChunk{
				ID: fmt.Sprintf("gold-%s-%d", gold.ID, window.Ordinal), Ordinal: window.Ordinal,
				Text: window.Text, TextHash: hashBytes([]byte(window.Text)),
			})
		}
		reference := core.KnowledgeEvidenceRef{
			Kind: core.KnowledgeEvidenceText, SourceID: "gold-source-" + gold.ID, ClaimID: "gold-claim-" + gold.ID,
			BlobHash: receipt.Hash, ByteStart: int64(gold.ByteStart), ByteEnd: int64(gold.ByteEnd), SpanHash: gold.SpanSHA256,
		}
		mapped, err := service.mapTextEvidence(reference, []adoptedRunDocument{document})
		expectedDecision := gold.ExpectedDecision
		if expectedDecision == "" {
			expectedDecision = "map"
		}
		if expectedDecision == "reject" {
			if err == nil {
				t.Errorf("case %s expected fail-closed rejection but mapped successfully: %+v", gold.ID, mapped)
				continue
			}
			if gold.ExpectedErrorContains == "" || !strings.Contains(err.Error(), gold.ExpectedErrorContains) {
				t.Errorf("case %s rejection = %v, want error containing %q", gold.ID, err, gold.ExpectedErrorContains)
				continue
			}
			correct++
			continue
		}
		if expectedDecision != "map" {
			t.Errorf("case %s has unsupported expected decision %q", gold.ID, expectedDecision)
			continue
		}
		if err != nil {
			t.Errorf("case %s map production evidence span: %v", gold.ID, err)
			continue
		}
		var mappedChunk *adoptedRunChunk
		for index := range document.Chunks {
			if document.Chunks[index].ID == mapped.ChunkID {
				mappedChunk = &document.Chunks[index]
				break
			}
		}
		if mappedChunk == nil || mappedChunk.Ordinal != gold.ExpectedChunkOrdinal ||
			mapped.StartByte < 0 || mapped.EndByte <= mapped.StartByte || mapped.EndByte > len(mappedChunk.Text) {
			t.Errorf("case %s mapped to an unexpected chunk or byte range: %+v", gold.ID, mapped)
			continue
		}
		mappedSpan := []byte(mappedChunk.Text[mapped.StartByte:mapped.EndByte])
		if !bytes.Equal(mappedSpan, goldSpan) || string(mappedSpan) != gold.Excerpt || hashBytes(mappedSpan) != gold.SpanSHA256 {
			t.Errorf("case %s mapped readback differs from gold excerpt", gold.ID)
			continue
		}
		correct++
	}
	accuracy := 100 * float64(correct) / float64(len(fixture.Cases))
	t.Logf("evidence span accuracy %.2f%% (%d/%d)", accuracy, correct, len(fixture.Cases))
	if accuracy < requiredSpanAccuracy || accuracy < fixture.MinimumAccuracyPercent {
		t.Fatalf("evidence span accuracy %.2f%% is below required %.2f%%", accuracy, max(requiredSpanAccuracy, fixture.MinimumAccuracyPercent))
	}
}

func materializeKnowledgeGoldText(gold knowledgeEvidenceSpanGoldCase) ([]byte, error) {
	if gold.RawText != "" && len(gold.Segments) != 0 {
		return nil, errors.New("gold text must use raw_text or segments, not both")
	}
	if gold.RawText != "" {
		return []byte(gold.RawText), nil
	}
	if len(gold.Segments) == 0 {
		return nil, errors.New("gold text is empty")
	}
	var builder strings.Builder
	for _, segment := range gold.Segments {
		if segment.Text == "" || segment.Repeat <= 0 || segment.Repeat > 10000 {
			return nil, errors.New("gold text segment has invalid text or repeat count")
		}
		for count := 0; count < segment.Repeat; count++ {
			builder.WriteString(segment.Text)
		}
	}
	return []byte(builder.String()), nil
}

func loadKnowledgeGoldFixture[T any](t *testing.T, name string) T {
	t.Helper()
	var fixture T
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate knowledge gold test source")
	}
	path := filepath.Join(filepath.Dir(source), "..", "..", "evals", "knowledge", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read gold fixture %s: %v", name, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		t.Fatalf("decode gold fixture %s: %v", name, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		t.Fatalf("gold fixture %s contains trailing JSON: %v", name, err)
	}
	return fixture
}
