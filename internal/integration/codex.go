package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/djkim0320/AetherOps/internal/codex"
	"github.com/djkim0320/AetherOps/internal/core"
	"github.com/djkim0320/AetherOps/internal/knowledge"
	"github.com/djkim0320/AetherOps/internal/research"
)

// CodexAdapter is the narrow bridge between the durable research state
// machine and Codex App Server. It deliberately exposes no provider fallback.
type CodexAdapter struct {
	Client  *codex.Client
	WorkDir string

	mu      sync.Mutex
	resumed map[string]string
}

var _ knowledge.ExtractionProtocol = (*CodexAdapter)(nil)

func NewCodexAdapter(client *codex.Client, workDir string) (*CodexAdapter, error) {
	if client == nil {
		return nil, errors.New("Codex client is required")
	}
	if strings.TrimSpace(workDir) == "" {
		return nil, errors.New("Codex work directory is required")
	}
	return &CodexAdapter{Client: client, WorkDir: workDir, resumed: make(map[string]string)}, nil
}

func (adapter *CodexAdapter) ValidateModel(_ context.Context, model, effort, serviceTier string) error {
	return adapter.Client.ValidateSelection(model, effort, serviceTier)
}

func (adapter *CodexAdapter) ValidateRunConfiguration(ctx context.Context, configuration core.RunConfiguration) error {
	if err := configuration.Validate(); err != nil {
		return err
	}
	return adapter.ValidateModel(ctx, configuration.Model, configuration.ReasoningEffort, configuration.ServiceTier)
}

func (adapter *CodexAdapter) ModelOptions() []core.ModelOption {
	models := adapter.Client.Models()
	options := make([]core.ModelOption, 0, len(models))
	for _, model := range models {
		identifier := model.ID
		if identifier == "" {
			identifier = model.Model
		}
		if model.Hidden || identifier == "" {
			continue
		}
		option := core.ModelOption{
			ID: identifier, DisplayName: model.DisplayName,
			DefaultReasoningEffort: model.DefaultReasoningEffort,
			SupportedSpeeds:        []string{"standard"},
		}
		if option.DisplayName == "" {
			option.DisplayName = identifier
		}
		for _, effort := range model.SupportedReasoningEfforts {
			option.SupportedReasoningEfforts = append(option.SupportedReasoningEfforts, effort.ReasoningEffort)
		}
		if model.SupportsFast() {
			option.SupportedSpeeds = append(option.SupportedSpeeds, "fast")
		}
		options = append(options, option)
	}
	return options
}

// ContextWindowUsage exposes only the latest real App Server measurement for
// the project's main thread. Missing telemetry remains explicitly unavailable.
func (adapter *CodexAdapter) ContextWindowUsage(_ context.Context, threadID string) (core.ContextWindowUsage, bool) {
	usage, ok := adapter.Client.ThreadUsage(threadID)
	if !ok || usage.ModelContextWindow == nil || *usage.ModelContextWindow <= 0 {
		return core.ContextWindowUsage{}, false
	}
	current := usage.Last.TotalTokens
	window := *usage.ModelContextWindow
	percent := (float64(current) / float64(window)) * 100
	if percent < 0 {
		percent = 0
	} else if percent > 100 {
		percent = 100
	}
	return core.ContextWindowUsage{
		Available: true, ThreadID: usage.ThreadID, TurnID: usage.TurnID,
		CurrentTokens: current, ContextWindow: window,
		InputTokens: usage.Last.InputTokens, CachedInputTokens: usage.Last.CachedInputTokens,
		OutputTokens: usage.Last.OutputTokens, ReasoningOutputTokens: usage.Last.ReasoningOutputTokens,
		UsedPercent: percent, UpdatedAt: usage.UpdatedAt,
	}, true
}

func (adapter *CodexAdapter) CreateThread(ctx context.Context, profile research.ModelProfile) (string, error) {
	if err := adapter.ValidateModel(ctx, profile.Model, profile.ReasoningEffort, profile.ServiceTier); err != nil {
		return "", err
	}
	return adapter.createThread(ctx, "aetherops-isolated-stage", profile.Model, profile.ReasoningEffort, researchContextProfile(profile.Model))
}

func (adapter *CodexAdapter) CreateMainThread(ctx context.Context, projectID string, configuration core.RunConfiguration) (string, error) {
	if strings.TrimSpace(projectID) == "" {
		return "", errors.New("project id is required")
	}
	if err := adapter.ValidateRunConfiguration(ctx, configuration); err != nil {
		return "", err
	}
	return adapter.createThread(ctx, "aetherops-project-"+projectID, configuration.Model, configuration.ReasoningEffort, configuration.NormalizedContextProfile())
}

func (adapter *CodexAdapter) Chat(
	ctx context.Context,
	threadID, message string,
	mode core.ChatMode,
	planCycleID string,
	configuration core.RunConfiguration,
) (core.ChatReply, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return core.ChatReply{}, errors.New("chat message is required")
	}
	if err := mode.Validate(); err != nil {
		return core.ChatReply{}, err
	}
	if err := adapter.ValidateRunConfiguration(ctx, configuration); err != nil {
		return core.ChatReply{}, err
	}
	if err := adapter.ensureResumed(ctx, threadID, configuration.Model, configuration.NormalizedContextProfile()); err != nil {
		return core.ChatReply{}, err
	}
	prompt := conversationChatPrompt(message)
	sandboxPolicy := json.RawMessage(`{"type":"readOnly","networkAccess":false}`)
	var outputSchema json.RawMessage
	if mode == core.ChatModePlan {
		if strings.TrimSpace(planCycleID) == "" {
			return core.ChatReply{}, errors.New("plan cycle id is required for planning chat")
		}
		prompt = planChatPrompt(message, planCycleID)
		outputSchema = planDialogueOutputSchema()
	}
	result, err := adapter.Client.Turn(ctx, threadID, codex.TurnOptions{
		Model: configuration.Model, Effort: configuration.ReasoningEffort, ServiceTier: configuration.ServiceTier,
		Prompt: prompt, OutputSchema: outputSchema, CWD: adapter.WorkDir, ApprovalPolicy: "on-request", SandboxPolicy: sandboxPolicy,
	})
	if err != nil {
		return core.ChatReply{}, err
	}
	if strings.TrimSpace(result.Text) == "" {
		return core.ChatReply{}, errors.New("Codex chat turn returned no assistant message")
	}
	reply := core.ChatReply{
		ThreadID: result.ThreadID, TurnID: result.TurnID, Mode: mode, Text: result.Text,
		Model: configuration.Model, ReasoningEffort: configuration.ReasoningEffort, ServiceTier: configuration.ServiceTier,
	}
	if mode == core.ChatModePlan {
		reply.PlanCycleID = planCycleID
		var dialogue core.PlanDialogue
		if err := json.Unmarshal([]byte(result.Text), &dialogue); err != nil {
			return core.ChatReply{}, errors.Join(errors.New("decode structured Codex plan dialogue"), err)
		}
		if err := dialogue.Validate(); err != nil {
			return core.ChatReply{}, errors.Join(errors.New("validate structured Codex plan dialogue"), err)
		}
		reply.PlanReady = dialogue.Status == "ready"
		reply.PlanQuestions = dialogue.Questions
		if reply.PlanReady {
			reply.Text = dialogue.Plan
		} else {
			reply.Text = dialogue.Message
		}
	}
	return reply, nil
}

// ChatHistory rebuilds the AetherOps chat projection from the App Server's
// durable thread. Research-stage turns are deliberately excluded: only turns
// carrying an AetherOps chat or plan prompt are user-facing conversation.
func (adapter *CodexAdapter) ChatHistory(ctx context.Context, threadID string) (core.ChatHistory, error) {
	history, err := adapter.Client.ReadThread(ctx, threadID)
	if err != nil {
		return core.ChatHistory{}, err
	}
	return projectChatHistory(history), nil
}

func projectChatHistory(history codex.ThreadHistory) core.ChatHistory {
	result := core.ChatHistory{ThreadID: history.ThreadID, Messages: make([]core.ChatHistoryMessage, 0)}
	for turnIndex, turn := range history.Turns {
		mode, displayText, planCycleID, visible, recognized := chatTurnUserMessage(turn)
		if !recognized {
			continue
		}
		startedAt := historyTime(turn.StartedAt, int64(turnIndex))
		if visible && strings.TrimSpace(displayText) != "" {
			result.Messages = append(result.Messages, core.ChatHistoryMessage{
				ID: historyItemID(turn, "user"), TurnID: turn.ID, Role: "user",
				Text: displayText, Mode: mode, CreatedAt: startedAt,
				PlanCycleID: planCycleID,
			})
		}
		assistantText, assistantID := historyAssistantText(turn)
		if strings.TrimSpace(assistantText) == "" {
			continue
		}
		message := core.ChatHistoryMessage{
			ID: assistantID, TurnID: turn.ID, Role: "assistant", Text: assistantText,
			Mode: mode, CreatedAt: historyTime(turn.CompletedAt, int64(turnIndex)).Add(time.Nanosecond),
			PlanCycleID: planCycleID,
		}
		if mode == core.ChatModePlan {
			var dialogue core.PlanDialogue
			if json.Unmarshal([]byte(assistantText), &dialogue) == nil && dialogue.Validate() == nil {
				message.PlanReady = dialogue.Status == "ready"
				message.PlanQuestions = dialogue.Questions
				if message.PlanReady {
					message.Text = dialogue.Plan
				} else {
					message.Text = dialogue.Message
				}
			}
		}
		result.Messages = append(result.Messages, message)
	}
	return result
}

func chatTurnUserMessage(turn codex.ThreadHistoryTurn) (core.ChatMode, string, string, bool, bool) {
	for _, item := range turn.Items {
		if item.Type != "userMessage" {
			continue
		}
		var prompt strings.Builder
		for _, content := range item.Content {
			if content.Type == "text" && content.Text != "" {
				if prompt.Len() != 0 {
					prompt.WriteByte('\n')
				}
				prompt.WriteString(content.Text)
			}
		}
		mode, message, planCycleID, ok := decodeAetherOpsChatPrompt(prompt.String())
		if !ok {
			continue
		}
		visible := !strings.Contains(message, "[AETHEROPS_PLAN_KICKOFF]")
		return mode, planAnswerDisplayText(message), planCycleID, visible, true
	}
	return core.ChatModeConversation, "", "", false, false
}

func decodeAetherOpsChatPrompt(prompt string) (core.ChatMode, string, string, bool) {
	const marker = "\n\n사용자 메시지:\n"
	var mode core.ChatMode
	switch {
	case strings.HasPrefix(prompt, "AetherOps 일반 대화 모드입니다."):
		mode = core.ChatModeConversation
	case strings.HasPrefix(prompt, "AetherOps 계획 모드입니다."):
		mode = core.ChatModePlan
	default:
		return "", "", "", false
	}
	header, message, found := strings.Cut(prompt, marker)
	if !found {
		return "", "", "", false
	}
	planCycleID := ""
	if mode == core.ChatModePlan {
		const cycleMarker = "\n계획 사이클 ID: "
		if _, value, found := strings.Cut(header, cycleMarker); found {
			planCycleID = strings.TrimSpace(strings.SplitN(value, "\n", 2)[0])
		}
	}
	return mode, strings.TrimSpace(message), planCycleID, true
}

func planAnswerDisplayText(message string) string {
	const prefix = "계획 질문에 대한 사용자의 선택입니다. 아래 답변을 기존 대화와 함께 반영하고, 더 필요한 결정이 있으면 다음 질문을 제시하고 충분하면 최종 계획을 작성하세요."
	if !strings.HasPrefix(message, prefix) {
		return message
	}
	_, answers, found := strings.Cut(message, "\n\n")
	if !found {
		return message
	}
	lines := strings.Split(answers, "\n")
	display := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "- "))
		questionEnd := strings.Index(line, "): ")
		headerEnd := strings.Index(line, " (")
		if questionEnd <= 0 || headerEnd <= 0 || headerEnd > questionEnd {
			continue
		}
		display = append(display, strings.TrimSpace(line[:headerEnd])+": "+strings.TrimSpace(line[questionEnd+3:]))
	}
	if len(display) == 0 {
		return message
	}
	return strings.Join(display, "\n")
}

func historyAssistantText(turn codex.ThreadHistoryTurn) (string, string) {
	finals := make([]codex.ThreadHistoryItem, 0)
	unknown := make([]codex.ThreadHistoryItem, 0)
	for _, item := range turn.Items {
		if item.Type != "agentMessage" || strings.TrimSpace(item.Text) == "" {
			continue
		}
		switch item.Phase {
		case "final_answer":
			finals = append(finals, item)
		case "commentary":
		default:
			unknown = append(unknown, item)
		}
	}
	selected := finals
	if len(selected) == 0 {
		selected = unknown
	}
	texts := make([]string, 0, len(selected))
	id := ""
	for _, item := range selected {
		texts = append(texts, strings.TrimSpace(item.Text))
		id = item.ID
	}
	if id == "" {
		id = historyItemID(turn, "assistant")
	}
	return strings.Join(texts, "\n"), id
}

func historyItemID(turn codex.ThreadHistoryTurn, role string) string {
	for _, item := range turn.Items {
		if role == "user" && item.Type == "userMessage" && item.ID != "" {
			return item.ID
		}
		if role == "assistant" && item.Type == "agentMessage" && item.ID != "" {
			return item.ID
		}
	}
	return turn.ID + "-" + role
}

func historyTime(value *int64, fallback int64) time.Time {
	if value != nil && *value > 0 {
		return time.Unix(*value, 0).UTC()
	}
	return time.Unix(fallback, 0).UTC()
}

func conversationChatPrompt(message string) string {
	return `AetherOps 일반 대화 모드입니다. 연구 파이프라인을 시작하거나 웹 탐색, 명령 실행, MCP 도구 호출, 파일 변경을 하지 말고 대화로만 답하세요. 사용자가 조사나 연구를 원하면 요구사항을 짧게 정리하도록 돕고 /plan 명령으로 계획 모드에 들어갈 수 있다고 안내하세요. 실제 연구는 /research 명령을 통해서만 시작됩니다.

사용자 메시지:
` + message
}

func planChatPrompt(message, planCycleID string) string {
	return `AetherOps 계획 모드입니다. Codex 계획 모드처럼 사용자의 의도를 짧게 인터뷰한 뒤 최종 실행 계획을 만드세요.

절대 연구를 실행하지 마세요. 웹 탐색, 명령 실행, MCP 도구 호출, 파일 변경을 하지 마세요. 현재 대화 맥락만 사용하세요.

현재 공학 실행 범위:
- XFOIL 최적화의 검증된 typed 계약은 NACA 4자리 기준 익형 하나와 sealed plain-flap 편향 후보군 비교만 지원합니다.
- 임의 좌표 입력, E387·SD7062 같은 비-NACA-4자리 익형, 서로 다른 익형 계열 비교는 아직 실행할 수 없습니다.
- XFOIL 실행이 필요한 계획에서는 지원되지 않는 후보를 선택지나 최종 계획에 넣지 마세요. 사용자의 원래 요청이 범위를 벗어나면 지원되는 NACA 4자리 plain-flap 최적화를 추천 선택지로 제시하고, 원래 범위는 현재 실행 불가라고 명시하세요.
- OpenVSP, Gmsh, SU2의 세부 지원 범위를 확신할 수 없으면 실행 가능하다고 단정하지 말고 계획의 미결 사항으로 남기세요.

응답 규칙:
- 목표, 범위, 비교 기준, 필요한 근거, 제외 범위, 결과물 형태, 완료 기준 중 결과를 실제로 바꾸는 정보가 부족하면 status를 needs_input으로 설정하세요.
- 사용자 메시지에 [AETHEROPS_PLAN_KICKOFF]가 있으면 아직 목표가 없는 상태이므로 반드시 needs_input으로 시작하세요.
- 한 번에 서로 독립적인 질문 1~3개만 제시하세요. 이미 답한 내용을 다시 묻지 마세요.
- 각 질문은 짧은 header, 명확한 question, 상호 배타적인 선택지 2~3개를 포함해야 합니다.
- 가장 합리적인 기본 선택지를 첫 번째에 두고 recommended=true로 설정하세요. 나머지는 false입니다.
- UI가 각 질문에 자유 입력 선택지를 별도로 추가하므로 options에 기타/직접 입력을 만들지 마세요.
- 정보가 충분하면 status를 ready로 설정하고 questions는 빈 배열로 두세요.
- 최종 plan은 Markdown으로 작성하고 목표, 합의된 범위, 실행 단계, 필요한 근거, 산출물, 완료 기준, 가정과 미결 사항을 포함하세요.
- needs_input일 때 plan은 빈 문자열이어야 하며, ready일 때 plan은 비어 있으면 안 됩니다.
- message는 현재 상태를 설명하는 짧은 한두 문장으로 항상 채우세요. JSON 밖의 텍스트는 출력하지 마세요.

계획 사이클 ID: ` + strings.TrimSpace(planCycleID) + `

사용자 메시지:
` + message
}

func planDialogueOutputSchema() json.RawMessage {
	return json.RawMessage(`{
		"type":"object",
		"additionalProperties":false,
		"properties":{
			"status":{"type":"string","enum":["needs_input","ready"]},
			"message":{"type":"string"},
			"questions":{"type":"array","maxItems":3,"items":{
				"type":"object","additionalProperties":false,
				"properties":{
					"id":{"type":"string"},
					"header":{"type":"string"},
					"question":{"type":"string"},
					"options":{"type":"array","minItems":2,"maxItems":3,"items":{
						"type":"object","additionalProperties":false,
						"properties":{
							"id":{"type":"string"},
							"label":{"type":"string"},
							"description":{"type":"string"},
							"recommended":{"type":"boolean"}
						},
						"required":["id","label","description","recommended"]
					}}
				},
				"required":["id","header","question","options"]
			}},
			"plan":{"type":"string"}
		},
		"required":["status","message","questions","plan"]
	}`)
}

func (adapter *CodexAdapter) createThread(ctx context.Context, serviceName, model, effort, contextProfile string) (string, error) {
	threadID, err := adapter.Client.StartThread(ctx, codex.ThreadOptions{
		Model:          model,
		Effort:         effort,
		CWD:            adapter.WorkDir,
		ApprovalPolicy: "on-request",
		Sandbox:        "workspace-write",
		ServiceName:    serviceName,
		Config:         codexContextConfig(model, contextProfile),
	})
	if err != nil {
		return "", err
	}
	adapter.mu.Lock()
	adapter.resumed[threadID] = contextProfileSignature(model, contextProfile)
	adapter.mu.Unlock()
	return threadID, nil
}

func (adapter *CodexAdapter) Turn(ctx context.Context, threadID string, options research.TurnOptions) (research.TurnResult, error) {
	if err := adapter.ensureResumed(ctx, threadID, options.Model, researchContextProfile(options.Model)); err != nil {
		return research.TurnResult{}, err
	}
	result, err := adapter.Client.Turn(ctx, threadID, codex.TurnOptions{
		Model:          options.Model,
		Effort:         options.ReasoningEffort,
		ServiceTier:    options.ServiceTier,
		Prompt:         options.Prompt,
		OutputSchema:   append(json.RawMessage(nil), options.Schema...),
		CWD:            adapter.WorkDir,
		ApprovalPolicy: "on-request",
		SandboxPolicy:  json.RawMessage(`{"type":"workspaceWrite","writableRoots":[],"networkAccess":true}`),
	})
	if err != nil && ctx.Err() != nil {
		// turn/start can be cancelled before its response exposes a turn id. In
		// that case the per-turn client cleanup has no addressable target, so
		// quiesce every live App Server turn before returning the failed stage.
		cleanupContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cleanupErr := adapter.Client.InterruptAll(cleanupContext)
		cancel()
		if cleanupErr != nil {
			err = errors.Join(err, fmt.Errorf("quiesce App Server after cancelled research turn: %w", cleanupErr))
		}
	}
	converted := research.TurnResult{
		ThreadID:        result.ThreadID,
		TurnID:          result.TurnID,
		Model:           options.Model,
		ReasoningEffort: options.ReasoningEffort,
		ServiceTier:     options.ServiceTier,
		Output:          json.RawMessage(result.Text),
	}
	var turnError *codex.TurnError
	if errors.As(err, &turnError) && turnError.Result.Status == "interrupted" {
		err = errors.Join(research.ErrTurnInterrupted, err)
	}
	return converted, err
}

// CreateExtractionThread starts an isolated thread for pinned-document
// knowledge extraction or review. Unlike research threads it has no writable
// sandbox surface. The selected model is explicit and validated before the
// App Server request; no provider or model fallback exists.
func (adapter *CodexAdapter) CreateExtractionThread(ctx context.Context, options knowledge.ExtractionThreadOptions) (string, error) {
	if err := adapter.ValidateModel(ctx, options.Model, options.ReasoningEffort, options.ServiceTier); err != nil {
		return "", err
	}
	threadID, err := adapter.Client.StartThread(ctx, codex.ThreadOptions{
		Model: options.Model, Effort: options.ReasoningEffort,
		CWD: adapter.WorkDir, ApprovalPolicy: "never", Sandbox: "read-only",
		ServiceName: options.ServiceName,
		Config:      codexContextConfig(options.Model, researchContextProfile(options.Model)),
	})
	if err != nil {
		return "", err
	}
	adapter.mu.Lock()
	adapter.resumed[threadID] = contextProfileSignature(options.Model, researchContextProfile(options.Model))
	adapter.mu.Unlock()
	return threadID, nil
}

// ExtractionTurn is a stable App Server turn with a fixed response schema and
// an offline read-only sandbox. Pinned source text is untrusted data, so the
// model is never given browser, network, or file mutation authority here.
func (adapter *CodexAdapter) ExtractionTurn(ctx context.Context, threadID string, options knowledge.ExtractionTurnOptions) (knowledge.ExtractionTurnResult, error) {
	if err := adapter.ensureResumed(ctx, threadID, options.Model, researchContextProfile(options.Model)); err != nil {
		return knowledge.ExtractionTurnResult{}, err
	}
	result, err := adapter.Client.Turn(ctx, threadID, codex.TurnOptions{
		Model: options.Model, Effort: options.ReasoningEffort, ServiceTier: options.ServiceTier,
		Prompt: options.Prompt, OutputSchema: append(json.RawMessage(nil), options.Schema...),
		CWD: adapter.WorkDir, ApprovalPolicy: "never",
		SandboxPolicy: json.RawMessage(`{"type":"readOnly","networkAccess":false}`),
	})
	converted := knowledge.ExtractionTurnResult{
		ThreadID: result.ThreadID, TurnID: result.TurnID,
		Model: options.Model, ReasoningEffort: options.ReasoningEffort,
		ServiceTier: options.ServiceTier, Output: json.RawMessage(result.Text),
	}
	return converted, err
}

func (adapter *CodexAdapter) Steer(ctx context.Context, threadID, message string) error {
	_, err := adapter.Client.SteerThread(ctx, threadID, message)
	return err
}

func (adapter *CodexAdapter) ensureResumed(ctx context.Context, threadID, model, contextProfile string) error {
	signature := contextProfileSignature(model, contextProfile)
	adapter.mu.Lock()
	if adapter.resumed[threadID] == signature {
		adapter.mu.Unlock()
		return nil
	}
	// Hold the small critical section across resume so concurrent collectors can
	// never submit two resume requests for the same durable thread.
	defer adapter.mu.Unlock()
	if err := adapter.Client.ResumeThreadWithConfig(ctx, threadID, codexContextConfig(model, contextProfile)); err != nil {
		return err
	}
	adapter.resumed[threadID] = signature
	return nil
}

func researchContextProfile(model string) string {
	if model == core.PlannerModel {
		return core.ContextProfileLong1M
	}
	return core.ContextProfileDefault
}

func contextProfileSignature(model, profile string) string {
	if model == core.PlannerModel && profile == core.ContextProfileLong1M {
		return core.ContextProfileLong1M
	}
	return core.ContextProfileDefault
}

func codexContextConfig(model, profile string) map[string]any {
	if model != core.PlannerModel || profile != core.ContextProfileLong1M {
		return nil
	}
	return map[string]any{
		"model_context_window":           core.LongContextTokens,
		"model_auto_compact_token_limit": core.LongContextCompactAt,
	}
}

type ResearchExecutor struct {
	Engine      *research.Engine
	OnSucceeded func(context.Context, string) error
}

func (executor ResearchExecutor) Execute(ctx context.Context, runID string) error {
	if executor.Engine == nil {
		return errors.New("research engine is required")
	}
	run, err := executor.Engine.Execute(ctx, runID)
	if err == nil && run.Status == core.RunSucceeded && executor.OnSucceeded != nil {
		err = executor.OnSucceeded(ctx, runID)
	}
	return err
}

func (executor ResearchExecutor) Steer(ctx context.Context, runID, message string) error {
	if executor.Engine == nil {
		return errors.New("research engine is required")
	}
	return executor.Engine.Steer(ctx, runID, message)
}

type DeviceLogin struct {
	Client *codex.Client
}

func (login DeviceLogin) StartDeviceLogin(ctx context.Context) (any, error) {
	if login.Client == nil {
		return nil, errors.New("Codex client is required")
	}
	result, err := login.Client.StartDeviceCodeLogin(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"login_id":         result.LoginID,
		"verification_uri": result.VerificationURL,
		"user_code":        result.UserCode,
	}, nil
}

func (login DeviceLogin) ReadCodexAccount(ctx context.Context) (any, error) {
	if login.Client == nil {
		return nil, errors.New("Codex client is required")
	}
	return login.Client.ReadAccount(ctx, false)
}
