package reportdocx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	reporttemplates "github.com/djkim0320/AetherOps/docs/templates"
	"github.com/djkim0320/AetherOps/internal/buildinfo"
	"github.com/djkim0320/AetherOps/internal/core"
)

func TestRenderBindsReviewedReportIntoEmbeddedTemplate(t *testing.T) {
	before := append([]byte(nil), reporttemplates.AetherOpsResearchReportTemplate...)
	input := visualFixtureInput()
	data, err := Render(input)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, reporttemplates.AetherOpsResearchReportTemplate) {
		t.Fatal("render mutated the embedded reference template")
	}

	reference := readPackage(t, before)
	rendered := readPackage(t, data)
	for _, part := range []string{
		"word/styles.xml", "word/numbering.xml", "word/footer1.xml",
		"word/theme/theme1.xml", "word/media/image1.png", "[Content_Types].xml",
	} {
		if !bytes.Equal(reference[part], rendered[part]) {
			t.Fatalf("preserve-only template part changed: %s", part)
		}
	}

	document := string(rendered[documentPart])
	for _, required := range []string{
		"익형 A &amp; B 최적화", "한눈에 보는 결론", "연구 질문과 범위",
		"공학 해석", "NACA 0015", "ListBullet", "ListNumber",
		"재현성 및 감사 부록", "품질 리뷰", "지식그래프 채택 요약",
		input.Run.ID, input.Project.Name,
	} {
		if !strings.Contains(document, required) {
			t.Fatalf("rendered document does not contain %q", required)
		}
	}
	if strings.Contains(document, "〈") || strings.Contains(document, coverUsageText) {
		t.Fatal("rendered document retained template instructions")
	}
	if !strings.Contains(string(rendered["word/header1.xml"]), input.Project.Name) {
		t.Fatal("project name was not bound into the recurring header")
	}
	if !strings.Contains(string(rendered[corePropertiesPart]), xmlText(input.Report.Title)) {
		t.Fatal("report title was not bound into core properties")
	}
	decoder := xml.NewDecoder(bytes.NewReader(rendered[documentPart]))
	for {
		_, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("rendered document XML is invalid: %v", err)
		}
	}
}

func TestRenderRejectsReportThatDidNotPassQualityGate(t *testing.T) {
	input := visualFixtureInput()
	input.Verdict.Scores.Completeness = 2
	if _, err := Render(input); err == nil || !strings.Contains(err.Error(), "quality-passing") {
		t.Fatalf("failing verdict render error = %v", err)
	}
}

// TestRenderVisualFixture writes one deterministic layout fixture only when a
// developer explicitly requests it. It is used by the Word/PNG render gate and
// is not a mock research-success result.
func TestRenderVisualFixture(t *testing.T) {
	output := strings.TrimSpace(os.Getenv("AETHEROPS_REPORT_DOCX_OUTPUT"))
	if output == "" {
		t.Skip("AETHEROPS_REPORT_DOCX_OUTPUT is not set")
	}
	data, err := Render(visualFixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func visualFixtureInput() Input {
	issued := time.Date(2026, 8, 30, 14, 35, 0, 0, time.UTC)
	return Input{
		Project: core.Project{ID: "prj_fixture", Name: "차세대 익형 연구", CreatedAt: issued, UpdatedAt: issued},
		Run: core.Run{
			ID: "run_0123456789abcdef0123456789abcdef", ProjectID: "prj_fixture",
			ConversationSessionID: "ses_0123456789abcdef0123456789abcdef",
			Question:              "NACA 0015 기반 저속 익형의 성능을 비교하고 다음 설계안을 권고해줘.",
			Status:                core.RunReviewing, Revision: 7,
			ResearchProfileVersion: core.ResearchProfileVersionV2,
			RetrievalProfile:       "hybrid_graph_v1",
			KnowledgeGenerationID:  "kgen_0123456789abcdef0123456789abcdef",
			Model:                  "gpt-5.6-sol", ReasoningEffort: "xhigh", ServiceTier: "default",
			ProductBuild: buildinfo.ProductBuildBinding{
				Version: buildinfo.ReleaseProductVersion, ExecutableSHA256: strings.Repeat("1", 64),
				RuntimeManifestSHA256: strings.Repeat("2", 64), KnowledgeSidecarTreeSHA256: strings.Repeat("3", 64),
			},
			CreatedAt: issued.Add(-2 * time.Hour), UpdatedAt: issued.Add(-time.Minute),
		},
		Report: core.ReportManifest{
			Title: "익형 A & B 최적화",
			AnswerMarkdown: `# 한눈에 보는 결론

검증된 조건에서는 후보 A가 기준선보다 높은 효율을 보였습니다 [1]. 다만 Reynolds 수가 달라지면 결론이 바뀔 수 있습니다.

- **결정:** 후보 A를 다음 설계 단계로 진행합니다.
- **경계 조건:** Re=1,000,000, Mach=0.10에서만 확인했습니다.
- 반대 근거와 불확실성을 함께 유지합니다.

## 연구 질문과 범위

NACA 0015 기반 후보의 저속 성능을 비교했습니다. 제조 공차와 천이 모델의 추가 보정은 제외했습니다.

## 방법과 근거

1. 공개 원문을 수집하고 CAS readback을 확인했습니다.
2. XFOIL과 독립 검증 계산을 비교했습니다.
3. 결과를 ` + "`hybrid_graph_v1`" + ` 지식 검색과 교차 확인했습니다.

## 핵심 결과

| 후보 | CL/CD | 판정 |
|---|---:|---|
| 기준선 | 71.2 | 비교 기준 |
| 후보 A | 78.5 | 우선 |
| 후보 B | 73.1 | 보류 |

> 수치 차이는 계산 완료 자체가 아니라 동일 조건·수렴 기준을 충족한 비교 결과입니다.

## 공학 해석

NACA 0015, Re=1,000,000, Mach=0.10 조건에서 수렴성과 민감도를 확인했습니다. 결론은 해당 운용점에 한정됩니다 [2].

## 결론 및 권고

후보 A를 진행하되 다음 격자·천이 민감도 검증이 실패하면 설계를 보류합니다.

## 한계와 불확실성

- 자료 범위가 제한적입니다.
- 실제 풍동 결과와의 정량 비교가 남았습니다.

## 출처

[1] 검증된 공개 자료. [2] AetherOps 공학 실행 receipt.`,
			Citations:      []core.Citation{{Marker: "[1]"}, {Marker: "[2]"}},
			EvidenceIDs:    []string{"workstream-0"},
			ArtifactHashes: []string{strings.Repeat("a", 64)},
			Uncertainties:  []string{"풍동 검증이 남아 있음"},
			KnowledgePatch: core.KnowledgePatch{
				SchemaVersion: core.KnowledgePatchSchemaV1, UnitRegistryVersion: core.CurrentUnitRegistryVersion,
				Entities: []core.KnowledgeEntity{{ID: "entity-a", Type: "airfoil", CanonicalName: "NACA 0015", Aliases: []core.KnowledgeAlias{}}},
				Assertions: []core.KnowledgeAssertion{{
					ID: "assertion-a", SubjectEntityID: "entity-a", Predicate: "has_result",
					ObjectLiteral: &core.KnowledgeTypedLiteral{LexicalForm: "78.5", Datatype: "http://www.w3.org/2001/XMLSchema#decimal"},
					Qualifiers:    []core.KnowledgeQualifier{}, Evidence: []core.KnowledgeEvidenceRef{{Kind: core.KnowledgeEvidenceEngineering}},
				}},
			},
		},
		Verdict: core.ReviewVerdict{
			CitationIntegrityPercent: 100,
			KnowledgeIntegrity:       &core.KnowledgeIntegrity{EvidenceIntegrityPercent: 100, UnsupportedAssertions: 0},
			CriticalErrors:           []string{},
			Scores: core.ReviewScores{
				TaskFulfillment: 5, ClaimSupport: 5, SourceQuality: 4,
				Completeness: 4, ReasoningAndUncertainty: 4, ClarityAndReproducibility: 5,
			},
			RevisionRequests: []string{}, RemediationAction: core.ReviewRemediationNone,
			RemediationTasks: []core.ReviewRemediationTask{}, Summary: "모든 자동 품질 기준을 충족했습니다.",
		},
		GeneratedAt: issued,
	}
}

func readPackage(t *testing.T, data []byte) map[string][]byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	parts := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		contents, err := readZipFile(file)
		if err != nil {
			t.Fatal(err)
		}
		parts[file.Name] = contents
	}
	return parts
}
