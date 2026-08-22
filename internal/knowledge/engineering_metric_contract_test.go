package knowledge

import (
	"reflect"
	"testing"

	"github.com/djkim0320/Aether-claw/internal/core"
)

func TestSU2KnowledgeProjectionUsesTheSharedMetricContract(t *testing.T) {
	if !reflect.DeepEqual(engineeringMetricContracts["su2_naca0012"], core.SU2MetricContractsV1()) {
		t.Fatal("SU2 knowledge projection diverged from the core metric contract")
	}
	copy := core.SU2MetricContractsV1()
	delete(copy, "cl_late_stddev")
	if _, exists := core.SU2MetricContractsV1()["cl_late_stddev"]; !exists {
		t.Fatal("caller mutation changed the shared SU2 metric authority")
	}
}
