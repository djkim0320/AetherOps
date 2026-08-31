package research

import (
	"strings"
	"testing"
)

func TestReportArtifactTemplatePolicyCoversAdoptedReportContract(t *testing.T) {
	if reportArtifactTemplateVersion != "aetherops_report_v1" {
		t.Fatalf("unexpected report template version %q", reportArtifactTemplateVersion)
	}
	for _, required := range []string{
		"한눈에 보는 결론",
		"연구 질문과 범위",
		"방법과 근거",
		"핵심 결과",
		"공학 해석",
		"결론 및 권고",
		"한계와 불확실성",
		"출처",
		"Do not expose chain-of-thought",
		"Do not add claims solely to make the template look complete",
	} {
		if !strings.Contains(reportArtifactTemplatePolicy, required) {
			t.Fatalf("report template policy omits %q", required)
		}
	}
}
