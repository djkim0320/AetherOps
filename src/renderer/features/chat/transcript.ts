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
  const consumed = new Set<number>();
  const byClientMutationId = new Map<string, IndexQueue>();
  const byContent = new Map<string, IndexQueue>();
  let userMessageIndex = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (message.clientMutationId) addIndex(byClientMutationId, message.clientMutationId, userMessageIndex);
    addIndex(byContent, message.content, userMessageIndex);
    userMessageIndex += 1;
  }
  return pending.filter((item) => {
    if (consumeIndex(byClientMutationId.get(item.clientMutationId), consumed)) return false;
    return !consumeIndex(byContent.get(item.content), consumed);
  });
}

interface IndexQueue {
  indexes: number[];
  cursor: number;
}

function addIndex(index: Map<string, IndexQueue>, key: string, value: number): void {
  const queue = index.get(key);
  if (queue) {
    queue.indexes.push(value);
    return;
  }
  index.set(key, { indexes: [value], cursor: 0 });
}

function consumeIndex(queue: IndexQueue | undefined, consumed: Set<number>): boolean {
  if (!queue) return false;
  while (queue.cursor < queue.indexes.length) {
    const index = queue.indexes[queue.cursor++];
    if (consumed.has(index)) continue;
    consumed.add(index);
    return true;
  }
  return false;
}
