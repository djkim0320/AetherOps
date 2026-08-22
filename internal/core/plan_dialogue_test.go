package core

import "testing"

func TestPlanDialogueValidation(t *testing.T) {
	questions := PlanDialogue{
		Status: "needs_input", Message: "먼저 범위를 정할게요.", Plan: "",
		Questions: []PlanQuestion{{
			ID: "scope", Header: "범위", Question: "어디까지 다룰까요?",
			Options: []PlanOption{
				{ID: "focused", Label: "핵심 범위", Description: "핵심 대상만 다룹니다.", Recommended: true},
				{ID: "broad", Label: "넓은 범위", Description: "연관 대상까지 포함합니다.", Recommended: false},
			},
		}},
	}
	if err := questions.Validate(); err != nil {
		t.Fatal(err)
	}
	ready := PlanDialogue{Status: "ready", Message: "계획이 준비됐습니다.", Plan: "# 계획\n\n1. 범위를 확정합니다."}
	if err := ready.Validate(); err != nil {
		t.Fatal(err)
	}
	questions.Questions[0].Options[1].Recommended = true
	if err := questions.Validate(); err == nil {
		t.Fatal("accepted multiple recommended options")
	}
}
