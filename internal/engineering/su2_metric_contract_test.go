package engineering

import (
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestGeneralSU2ModelEvidenceUsesTheSharedMetricContract(t *testing.T) {
	contracts := core.SU2GeneralMetricContractsV1()
	paths := engineeringMetricEvidencePaths["su2_cfd"]
	if len(paths) != len(contracts) {
		t.Fatalf("general SU2 model paths=%d contracts=%d", len(paths), len(contracts))
	}
	for _, path := range paths {
		if len(path) != 1 {
			t.Fatalf("general SU2 scalar path is nested: %#v", path)
		}
		if _, exists := contracts[path[0]]; !exists {
			t.Fatalf("general SU2 model path is unknown: %#v", path)
		}
	}
}
