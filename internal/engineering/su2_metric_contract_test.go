package engineering

import (
	"testing"

	"github.com/djkim0320/AetherOps/internal/core"
)

func TestSU2ModelEvidenceUsesTheSharedMetricContract(t *testing.T) {
	contracts := core.SU2MetricContractsV1()
	paths := engineeringMetricEvidencePaths["su2_naca0012"]
	if len(paths) != len(contracts) {
		t.Fatalf("SU2 model paths=%d contracts=%d", len(paths), len(contracts))
	}
	seen := make(map[string]bool, len(paths))
	for _, path := range paths {
		if len(path) != 1 {
			t.Fatalf("SU2 scalar path is nested: %#v", path)
		}
		if _, exists := contracts[path[0]]; !exists || seen[path[0]] {
			t.Fatalf("SU2 model path is unknown or repeated: %#v", path)
		}
		seen[path[0]] = true
	}
}
