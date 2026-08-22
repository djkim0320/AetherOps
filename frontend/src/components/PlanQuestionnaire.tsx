import type { ChatMessage, PlanSelection } from "../types";

export type PlanQuestionnaireProps = {
  message: ChatMessage;
  selections: Record<string, PlanSelection>;
  submitted: boolean;
  disabled: boolean;
  onSelect: (questionID: string, optionID: string) => void;
  onCustom: (questionID: string, value: string) => void;
  onSubmit: () => void;
};

export function PlanQuestionnaire({
  message,
  selections,
  submitted,
  disabled,
  onSelect,
  onCustom,
  onSubmit
}: PlanQuestionnaireProps) {
  const questions = message.planQuestions ?? [];
  if (!questions.length) return null;
  const answeredCount = questions.filter((q) => {
    const sel = selections[q.id];
    return sel && (sel.optionID !== "__other__" || sel.custom.trim().length > 0);
  }).length;
  const allAnswered = answeredCount === questions.length;

  return (
    <div class={submitted ? "plan-questionnaire submitted" : "plan-questionnaire"}>
      <div class="plan-questionnaire-head">
        <span>
          계획 세부 선택 ({answeredCount}/{questions.length})
        </span>
        <small>{submitted ? "선택 제출 완료" : "각 항목을 선택하거나 직접 입력하세요"}</small>
      </div>
      {questions.map((question, qIdx) => {
        const sel = selections[question.id];
        const isOther = sel?.optionID === "__other__";
        return (
          <fieldset class="plan-question" key={question.id}>
            <legend>
              <span>{qIdx + 1}</span>
              <div>
                <small>{question.header}</small>
                <strong>{question.question}</strong>
              </div>
            </legend>
            <div class="plan-option-list">
              {question.options.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  class={sel?.optionID === option.id ? "selected" : ""}
                  onClick={() => onSelect(question.id, option.id)}
                  disabled={disabled || submitted}
                >
                  <span class="plan-option-radio" />
                  <span>
                    <strong>
                      {option.label}
                      {option.is_recommended && <em>추천</em>}
                    </strong>
                    <small>{option.description}</small>
                  </span>
                </button>
              ))}
              <button
                type="button"
                class={isOther ? "selected" : ""}
                onClick={() => onSelect(question.id, "__other__")}
                disabled={disabled || submitted}
              >
                <span class="plan-option-radio" />
                <span>
                  <strong>직접 입력</strong>
                  <small>다른 답변이나 특별한 요구사항을 작성합니다.</small>
                </span>
              </button>
            </div>
            {isOther && (
              <input
                class="plan-custom-answer"
                type="text"
                value={sel?.custom ?? ""}
                onInput={(e) => onCustom(question.id, e.currentTarget.value)}
                placeholder="요구사항을 직접 입력하세요."
                disabled={disabled || submitted}
              />
            )}
          </fieldset>
        );
      })}
      {!submitted && (
        <div class="plan-questionnaire-footer">
          <span>모든 항목을 선택하면 답변이 전송됩니다.</span>
          <button
            type="button"
            class="button"
            onClick={onSubmit}
            disabled={disabled || !allAnswered}
          >
            답변 제출
          </button>
        </div>
      )}
    </div>
  );
}
