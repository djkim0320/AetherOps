//go:build windows && amd64

package su2host

import (
	"os"
	"reflect"
	"testing"
	"time"
)

func TestObserveNativeIsRegisterBackedAndEnvironmentIndependent(t *testing.T) {
	before, err := ObserveNative()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AETHEROPS_SU2_AVX2", "0")
	t.Setenv("AETHEROPS_SU2_HOST_COMPATIBLE", "0")
	t.Setenv("PROCESSOR_IDENTIFIER", "fabricated")
	after, err := ObserveNative()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("native CPUID observation changed after environment mutation: before=%+v after=%+v", before, after)
	}
	if err := before.Validate(); err != nil {
		t.Fatal(err)
	}
	t.Logf("native SU2 host compatible=%t hypervisor=%t vendor=%s signature=%08x leaf1=%08x leaf7=%08x xcr0=%x missing=%v", before.Compatible(), before.HypervisorPresent, before.VendorID, before.ProcessorSignature, before.Leaf1ECX, before.Leaf7EBX, before.XCR0, before.Missing())
}

func TestCandidatePreflightBindsExecutableAndNeverAttemptsSU2(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := CandidatePreflight(executable, testTime)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.SU2ExecutionAttempted || receipt.Compatible != receipt.Observation.Compatible() {
		t.Fatalf("unexpected candidate receipt: %+v", receipt)
	}
}

var testTime = func() (value time.Time) { return time.Unix(1_700_000_000, 0).UTC() }()
