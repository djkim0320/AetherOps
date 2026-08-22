package core

import "testing"

func TestLongContextProfileIsSolOnly(t *testing.T) {
	sol := RunConfiguration{
		Model: PlannerModel, ReasoningEffort: PlannerEffort,
		ServiceTier: ServiceTierDefault, ContextProfile: ContextProfileLong1M,
	}
	if err := sol.Validate(); err != nil {
		t.Fatalf("Sol long context was rejected: %v", err)
	}
	terra := sol
	terra.Model = CollectorModel
	terra.ReasoningEffort = CollectorEffort
	if err := terra.Validate(); err == nil {
		t.Fatal("non-Sol model accepted the 1M context profile")
	}
	if got := (RunConfiguration{}).NormalizedContextProfile(); got != ContextProfileDefault {
		t.Fatalf("empty context profile normalized to %q", got)
	}
}
