import type { ChatMessage, ChatMode, PlanQuestion } from "./types";

type RecordValue = Record<string, unknown>;

function recordValue(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function chatHistoryMessages(payload: unknown, sessionID: string): ChatMessage[] {
  const root = recordValue(payload);
  const source = Array.isArray(payload)
    ? payload
    : root && Array.isArray(root.messages)
      ? root.messages
      : [];
  const messages: ChatMessage[] = [];
  source.forEach((entry, index) => {
    const item = recordValue(entry);
    if (!item) return;
    const role = item.role;
    const text = textValue(item.text);
    if ((role !== "user" && role !== "assistant" && role !== "system") || !text) return;
    const mode: ChatMode = textValue(item.mode) === "plan" ? "plan" : "chat";
    messages.push({
      id: textValue(item.id) ?? `history-${sessionID}-${index}`,
      sessionID,
      role,
      text,
      mode,
      createdAt: textValue(item.created_at) ?? "",
      planReady: item.plan_ready === true,
      planQuestions: Array.isArray(item.plan_questions) ? item.plan_questions as PlanQuestion[] : undefined,
      planCycleID: textValue(item.plan_cycle_id)
    });
  });
  return messages;
}
