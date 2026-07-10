export const JOB_KINDS = ["research_loop", "chat_reply", "engineering_run"] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested",
  "aborted",
  "interrupted",
  "blocked",
  "failed",
  "completed"
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
