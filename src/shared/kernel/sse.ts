export const SSE_EVENT_NAMES = [
  "project.snapshot.changed",
  "chat.message.appended",
  "run.status.changed",
  "run.step.changed",
  "tool.run.changed",
  "artifact.created"
] as const;

export type SseEventName = (typeof SSE_EVENT_NAMES)[number];
