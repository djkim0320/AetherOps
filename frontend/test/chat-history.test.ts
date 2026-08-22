import assert from "node:assert/strict";
import test from "node:test";

import { chatHistoryMessages } from "../src/chat-history.ts";

test("chat history restores conversation and structured plan messages", () => {
  const messages = chatHistoryMessages({ messages: [
    { id: "m1", role: "user", text: "조건을 잡아보자", mode: "chat", created_at: "2026-08-20T00:00:00Z" },
    {
      id: "m2", role: "assistant", text: "해석 범위를 고르세요", mode: "plan",
      plan_questions: [{ id: "scope", header: "범위", question: "어디까지 볼까요?", options: [] }],
      plan_cycle_id: "pln_1"
    }
  ] }, "ses_1");

  assert.equal(messages.length, 2);
  assert.equal(messages[0].sessionID, "ses_1");
  assert.equal(messages[0].text, "조건을 잡아보자");
  assert.equal(messages[1].mode, "plan");
  assert.equal(messages[1].planCycleID, "pln_1");
  assert.equal(messages[1].planQuestions?.[0]?.id, "scope");
});

test("chat history ignores malformed entries", () => {
  const messages = chatHistoryMessages({ messages: [
    null,
    { id: "missing-text", role: "assistant" },
    { id: "bad-role", role: "tool", text: "hidden" },
    { id: "valid", role: "assistant", text: "visible", mode: "unknown" }
  ] }, "ses_2");

  assert.deepEqual(messages.map((message) => message.id), ["valid"]);
  assert.equal(messages[0].mode, "chat");
});
