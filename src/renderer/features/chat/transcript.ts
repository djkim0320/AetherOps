import { z } from "zod";
import { ChatMessageSchema, type ChatMessage } from "../../../contracts/api-v2/jobs.js";

export interface PendingChatMessage {
  clientMutationId: string;
  content: string;
}

export function selectChatMessages(value: unknown, sessionId?: string): ChatMessage[] {
  const parsed = z.array(ChatMessageSchema).safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.filter((message) => !sessionId || message.sessionId === sessionId);
}

export function pendingMessagesForDisplay(messages: ChatMessage[], pending: PendingChatMessage[]): PendingChatMessage[] {
  const unmatchedUserMessages = messages.filter((message) => message.role === "user");
  return pending.filter((item) => {
    const exactIndex = unmatchedUserMessages.findIndex((message) => message.clientMutationId === item.clientMutationId);
    const contentIndex = exactIndex >= 0 ? exactIndex : unmatchedUserMessages.findIndex((message) => message.content === item.content);
    if (contentIndex < 0) return true;
    unmatchedUserMessages.splice(contentIndex, 1);
    return false;
  });
}
