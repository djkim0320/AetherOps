import { pendingMessagesForDisplay, selectChatMessages } from "./transcript.js";

const createdAt = "2026-07-10T00:00:00.000Z";

describe("chat transcript selectors", () => {
  it("selects the canonical session transcript after a snapshot reload", () => {
    const messages = selectChatMessages(
      [
        { id: "message-user", projectId: "project-1", sessionId: "session-1", role: "user", content: "Question", createdAt },
        { id: "message-assistant", projectId: "project-1", sessionId: "session-1", role: "assistant", content: "Answer", createdAt },
        { id: "message-other", projectId: "project-1", sessionId: "session-2", role: "user", content: "Other", createdAt }
      ],
      "session-1"
    );

    expect(messages.map((message) => `${message.role}:${message.content}`)).toEqual(["user:Question", "assistant:Answer"]);
  });

  it("reconciles optimistic messages by client id and reload-safe committed content without collapsing duplicates", () => {
    const messages = selectChatMessages([
      { id: "message-1", projectId: "project-1", sessionId: "session-1", role: "user", content: "Same", clientMutationId: "mutation-1", createdAt },
      { id: "message-2", projectId: "project-1", sessionId: "session-1", role: "user", content: "Same", createdAt }
    ]);
    const pending = [
      { clientMutationId: "mutation-1", content: "Same" },
      { clientMutationId: "mutation-2", content: "Same" },
      { clientMutationId: "mutation-3", content: "Same" }
    ];

    expect(pendingMessagesForDisplay(messages, pending)).toEqual([{ clientMutationId: "mutation-3", content: "Same" }]);
  });
});
