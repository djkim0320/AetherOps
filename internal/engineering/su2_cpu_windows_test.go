//go:build windows && amd64

package engineering

import (
	"strings"
	"testing"
)

func TestSU2CPUPreflightRequiresEveryFeature(t *testing.T) {
	compatible := su2CPUFeatures{AVX2: true, FMA: true, BMI1: true, BMI2: true, OSAVXState: true}
	if !compatible.compatible() || su2CPUIncompatibility(compatible) != "" {
		t.Fatal("complete SU2 CPU feature set was rejected")
	}

	tests := []struct {
		name    string
		missing string
		mutate  func(*su2CPUFeatures)
	}{
		{"avx2", "AVX2", func(features *su2CPUFeatures) { features.AVX2 = false }},
		{"fma", "FMA", func(features *su2CPUFeatures) { features.FMA = false }},
		{"bmi1", "BMI1", func(features *su2CPUFeatures) { features.BMI1 = false }},
		{"bmi2", "BMI2", func(features *su2CPUFeatures) { features.BMI2 = false }},
		{"osxsave", "OSXSAVE/XMM/YMM state", func(features *su2CPUFeatures) { features.OSAVXState = false }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			features := compatible
			test.mutate(&features)
			if features.compatible() {
				t.Fatalf("feature set missing %s was accepted", test.missing)
			}
			detail := su2CPUIncompatibility(features)
			if !strings.Contains(detail, "missing: "+test.missing) {
				t.Fatalf("incompatibility detail %q does not identify %s", detail, test.missing)
			}
		})
	}
}

func TestNativeSU2CPUPreflightIsSelfConsistent(t *testing.T) {
	features := detectSU2CPUFeatures()
	detail := su2CPUIncompatibility(features)
	if features.compatible() != (detail == "") {
		t.Fatalf("native feature result and diagnostic disagree: features=%+v detail=%q", features, detail)
	}
	t.Logf("native SU2 preflight: compatible=%t AVX2=%t FMA=%t BMI1=%t BMI2=%t OSXSAVE_XMM_YMM=%t",
		features.compatible(), features.AVX2, features.FMA, features.BMI1, features.BMI2, features.OSAVXState)
}
