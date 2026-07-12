import { describe, expect, it } from "vitest";
import * as kernel from "../../../src/shared/kernel/index.js";
import { CAPABILITY_KINDS, CAPABILITY_SCOPES } from "../../../src/shared/kernel/capability.js";
import { JOB_KINDS, JOB_STATUSES } from "../../../src/shared/kernel/job.js";
import { RESEARCH_LOOP_STEPS } from "../../../src/shared/kernel/researchLoop.js";
import { SSE_EVENT_NAMES } from "../../../src/shared/kernel/sse.js";

describe("shared kernel vocabulary", () => {
  it("keeps the canonical research loop step set", () => {
    expect(RESEARCH_LOOP_STEPS).toEqual([
      "CREATE_RESEARCH_DB",
      "INPUT_RESEARCH_QUESTION_HYPOTHESIS",
      "BUILD_RESEARCH_SPECIFICATION",
      "PLAN_RESEARCH",
      "EXECUTE_TOOLS",
      "NORMALIZE_DATA",
      "BUILD_VECTOR_INDEX",
      "BUILD_ONTOLOGY_GRAPH",
      "REASON_AND_VALIDATE",
      "SYNTHESIZE_AND_EVALUATE",
      "DECIDE_CONTINUATION",
      "FINALIZE_OUTPUTS"
    ]);
    expectUnique(RESEARCH_LOOP_STEPS);
  });

  it("keeps the public job kind and job status sets", () => {
    expect(JOB_KINDS).toEqual(["research_loop", "chat_reply", "engineering_run"]);
    expect(JOB_STATUSES).toEqual([
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
    ]);
    expectUnique(JOB_KINDS);
    expectUnique(JOB_STATUSES);
  });

  it("keeps the capability vocabulary", () => {
    expect(CAPABILITY_KINDS).toEqual(["agent", "engineering", "search"]);
    expect(CAPABILITY_SCOPES).toEqual(["app", "project", "operation"]);
    expectUnique(CAPABILITY_KINDS);
    expectUnique(CAPABILITY_SCOPES);
  });

  it("keeps the SSE event name set", () => {
    expect(SSE_EVENT_NAMES).toEqual([
      "project.snapshot.changed",
      "chat.message.appended",
      "run.status.changed",
      "run.step.changed",
      "tool.run.changed",
      "artifact.created"
    ]);
    expectUnique(SSE_EVENT_NAMES);
  });

  it("exports only stable runtime vocabulary from the index", () => {
    expect(Object.keys(kernel).sort()).toEqual(
      [
        "CAPABILITY_KINDS",
        "CAPABILITY_SCOPES",
        "JOB_KINDS",
        "JOB_STATUSES",
        "RESEARCH_LOOP_STEPS",
        "SSE_EVENT_NAMES",
        "isValidPublicSourceDomain",
        "normalizePublicSourceDomain"
      ].sort()
    );
  });
});

function expectUnique(values: readonly string[]): void {
  expect(new Set(values).size).toBe(values.length);
}
