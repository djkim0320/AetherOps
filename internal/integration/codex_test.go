package integration

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
)

func TestChatPromptsKeepConversationSeparateFromResearchExecution(t *testing.T) {
	conversation := conversationChatPrompt("시장에 대해 이야기해 보자")
	if !strings.Contains(conversation, "실제 연구는 /research 명령을 통해서만 시작") ||
		!strings.Contains(conversation, "시장에 대해 이야기해 보자") {
		t.Fatalf("conversation prompt did not preserve the execution boundary: %q", conversation)
	}
	plan := planChatPrompt("경쟁사 범위를 정하자", "pln_test", "NACA 0012 SU2 격자 민감도")
	for _, required := range []string{"절대 연구를 실행하지 마세요", "MCP 도구 호출", "needs_input", "상호 배타적인 선택지", "경쟁사 범위를 정하자", "NACA 0012 SU2 격자 민감도", "su2_naca0012", "do not redirect the user to XFOIL"} {
		if !strings.Contains(plan, required) {
			t.Fatalf("plan prompt is missing %q: %q", required, plan)
		}
	}
}

func TestCodexContextConfigIsLongOnlyForSol(t *testing.T) {
	config := codexContextConfig(core.PlannerModel, core.ContextProfileLong1M)
	if config["model_context_window"] != core.LongContextTokens || config["model_auto_compact_token_limit"] != core.LongContextCompactAt {
		t.Fatalf("Sol long-context config = %#v", config)
	}
	if got := codexContextConfig(core.CollectorModel, core.ContextProfileLong1M); got != nil {
		t.Fatalf("Terra received long-context config: %#v", got)
	}
	if got := codexContextConfig(core.PlannerModel, core.ContextProfileDefault); got != nil {
		t.Fatalf("default Sol profile received overrides: %#v", got)
	}
}

func TestResearchReviewerOwnsASeparateReadOnlySessionPolicy(t *testing.T) {
	service, approval, sandbox, err := isolatedResearchStageThreadPolicy(core.StageReview)
	if err != nil {
		t.Fatal(err)
	}
	if service != "aetherops-reviewer" || approval != "never" || sandbox != "read-only" {
		t.Fatalf("reviewer thread policy = %q/%q/%q", service, approval, sandbox)
	}
	service, approval, sandbox, err = isolatedResearchStageThreadPolicy(core.StageCollect)
	if err != nil {
		t.Fatal(err)
	}
	if service != "aetherops-collector" || approval != "on-request" || sandbox != "workspace-write" {
		t.Fatalf("collector thread policy = %q/%q/%q", service, approval, sandbox)
	}
	if _, _, _, err := isolatedResearchStageThreadPolicy(core.StagePlan); err == nil {
		t.Fatal("project PLAN was allowed to masquerade as an isolated worker session")
	}

	approval, turnSandbox, err := researchTurnPolicy(core.StageReview)
	if err != nil {
		t.Fatal(err)
	}
	if approval != "never" || string(turnSandbox) != `{"type":"readOnly","networkAccess":false}` {
		t.Fatalf("reviewer turn policy = %q/%s", approval, turnSandbox)
	}
	approval, turnSandbox, err = researchTurnPolicy(core.StageCollect)
	if err != nil {
		t.Fatal(err)
	}
	if approval != "on-request" || string(turnSandbox) != `{"type":"workspaceWrite","writableRoots":[],"networkAccess":true}` {
		t.Fatalf("collector turn policy = %q/%s", approval, turnSandbox)
	}
}

func TestChatHistoryProjectionRecognizesOnlyAetherOpsConversationTurns(t *testing.T) {
	mode, message, _, visible, recognized := chatTurnUserMessage(codex.ThreadHistoryTurn{Items: []codex.ThreadHistoryItem{{
		ID: "user-1", Type: "userMessage", Content: []codex.ThreadHistoryContent{{Type: "text", Text: conversationChatPrompt("안녕하세요")}},
	}}})
	if !recognized || !visible || mode != core.ChatModeConversation || message != "안녕하세요" {
		t.Fatalf("conversation projection = %q %q visible=%v recognized=%v", mode, message, visible, recognized)
	}

	_, _, _, visible, recognized = chatTurnUserMessage(codex.ThreadHistoryTurn{Items: []codex.ThreadHistoryItem{{
		Type: "userMessage", Content: []codex.ThreadHistoryContent{{Type: "text", Text: planChatPrompt("[AETHEROPS_PLAN_KICKOFF] 시작", "pln_kickoff", "새 연구 목표")}},
	}}})
	if !recognized || visible {
		t.Fatalf("plan kickoff visibility = %v, recognized=%v", visible, recognized)
	}

	_, _, _, _, recognized = chatTurnUserMessage(codex.ThreadHistoryTurn{Items: []codex.ThreadHistoryItem{{
		Type: "userMessage", Content: []codex.ThreadHistoryContent{{Type: "text", Text: "research stage prompt"}},
	}}})
	if recognized {
		t.Fatal("research-stage turn was exposed as conversation history")
	}
}

func TestPlanAnswerHistoryUsesTheSameCompactDisplayTextAsLiveChat(t *testing.T) {
	prompt := "계획 질문에 대한 사용자의 선택입니다. 아래 답변을 기존 대화와 함께 반영하고, 더 필요한 결정이 있으면 다음 질문을 제시하고 충분하면 최종 계획을 작성하세요.\n\n" +
		"- 범위 (어디까지 조사할까요?): 국내 — 한국 시장만\n- 형식 (결과 형식은?): 보고서 — 인용 포함"
	want := "범위: 국내 — 한국 시장만\n형식: 보고서 — 인용 포함"
	if got := planAnswerDisplayText(prompt); got != want {
		t.Fatalf("display text = %q, want %q", got, want)
	}
}

func TestHistoryAssistantTextPrefersFinalAnswerOverCommentary(t *testing.T) {
	text, id := historyAssistantText(codex.ThreadHistoryTurn{ID: "turn-1", Items: []codex.ThreadHistoryItem{
		{ID: "commentary", Type: "agentMessage", Text: "진행 중", Phase: "commentary"},
		{ID: "final", Type: "agentMessage", Text: "완료 답변", Phase: "final_answer"},
	}})
	if text != "완료 답변" || id != "final" {
		t.Fatalf("assistant projection = %q/%q", text, id)
	}
}

func TestProjectChatHistoryRestoresStructuredPlanDialogue(t *testing.T) {
	started, completed := int64(1_700_000_000), int64(1_700_000_001)
	history := projectChatHistory(codex.ThreadHistory{ThreadID: "thread-1", Turns: []codex.ThreadHistoryTurn{{
		ID: "turn-1", Status: "completed", StartedAt: &started, CompletedAt: &completed,
		Items: []codex.ThreadHistoryItem{
			{ID: "user-1", Type: "userMessage", Content: []codex.ThreadHistoryContent{{Type: "text", Text: planChatPrompt("경쟁사 범위를 정하자", "pln_history", "내부 권위 목표")}}},
			{ID: "assistant-1", Type: "agentMessage", Phase: "final_answer", Text: `{"status":"needs_input","message":"범위를 골라 주세요.","questions":[{"id":"scope","header":"범위","question":"어디까지 볼까요?","options":[{"id":"kr","label":"국내","description":"한국 시장","recommended":true},{"id":"global","label":"글로벌","description":"해외 포함","recommended":false}]}],"plan":""}`},
		},
	}}})
	if history.ThreadID != "thread-1" || len(history.Messages) != 2 {
		t.Fatalf("history=%+v", history)
	}
	assistant := history.Messages[1]
	if assistant.Role != "assistant" || assistant.Mode != core.ChatModePlan || assistant.Text != "범위를 골라 주세요." || assistant.PlanReady || len(assistant.PlanQuestions) != 1 {
		t.Fatalf("restored plan message=%+v", assistant)
	}
	if !assistant.CreatedAt.After(history.Messages[0].CreatedAt) {
		t.Fatalf("history timestamps are not ordered: %+v", history.Messages)
	}
}

func TestPlanDialogueOutputSchemaRequiresEveryProperty(t *testing.T) {
	var schema struct {
		Required   []string `json:"required"`
		Properties map[string]struct {
			Items *struct {
				Required   []string `json:"required"`
				Properties map[string]struct {
					Items *struct {
						Required []string `json:"required"`
					} `json:"items"`
				} `json:"properties"`
			} `json:"items"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(planDialogueOutputSchema(), &schema); err != nil {
		t.Fatal(err)
	}
	if strings.Join(schema.Required, ",") != "status,message,questions,plan" {
		t.Fatalf("top-level required fields = %v", schema.Required)
	}
	questions := schema.Properties["questions"].Items
	if questions == nil || strings.Join(questions.Required, ",") != "id,header,question,options" {
		t.Fatalf("question required fields = %+v", questions)
	}
	options := questions.Properties["options"].Items
	if options == nil || strings.Join(options.Required, ",") != "id,label,description,recommended" {
		t.Fatalf("option required fields = %+v", options)
	}
}
