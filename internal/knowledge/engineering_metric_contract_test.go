package knowledge

import (
	"reflect"
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestGeneralSU2KnowledgeProjectionUsesTheSharedMetricContract(t *testing.T) {
	if !reflect.DeepEqual(engineeringMetricContracts["su2_cfd"], core.SU2GeneralMetricContractsV1()) {
		t.Fatal("general SU2 knowledge projection diverged from the core metric contract")
	}
	if engineeringArtifactOnlyMetrics["su2_cfd"]["final_values"] != engineeringArtifactMetricObject {
		t.Fatal("arbitrary SU2 history columns must remain an artifact-only object")
	}
}
