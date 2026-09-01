import assert from "node:assert/strict";
import test from "node:test";

import { retainRunEventHistory, stageState } from "../src/run-progress.ts";
import type { RunEvent } from "../src/api.ts";
import type { Run } from "../src/types.ts";

function run(status: string): Run {
  return {
    id: "run_1",
    project_id: "project_1",
    conversation_session_id: "session_1",
    question: "test",
    status
  };
}

test("active collection marks PLAN complete and COLLECT active", () => {
  const current = run("collecting");
  assert.equal(stageState("plan", current), "complete");
  assert.equal(stageState("collect", current), "active");
  assert.equal(stageState("synthesize", current), "waiting");
});

test("terminal collection failure preserves completed stages and highlights the failed stage", () => {
  const current = run("failed");
  const events = [
    { sequence: 2, run_id: current.id, kind: "stage.started", payload: { stage: "collect" } },
    { sequence: 1, run_id: current.id, kind: "stage.started", payload: { stage: "plan" } }
  ];
  assert.equal(stageState("plan", current, events), "complete");
  assert.equal(stageState("collect", current, events), "attention");
  assert.equal(stageState("review", current, events), "waiting");
});

test("waiting approval keeps the event-derived stage without inventing review progress", () => {
  const current = run("waiting_approval");
  const events = [
    { sequence: 4, run_id: current.id, kind: "stage.started", payload: { stage: "collect" } }
  ];
  assert.equal(stageState("plan", current, events), "complete");
  assert.equal(stageState("collect", current, events), "waiting");
  assert.equal(stageState("synthesize", current, events), "waiting");
});

test("successful research marks every stage complete", () => {
  const current = run("succeeded");
  for (const stage of ["plan", "collect", "synthesize", "review"] as const) {
    assert.equal(stageState(stage, current), "complete");
  }
});

test("bounded activity history preserves stage markers through noisy artifact events", () => {
  const current = run("waiting_approval");
  let history: RunEvent[] = [];
  history = retainRunEventHistory(
    { event_id: "stage-plan", sequence: 1, run_id: current.id, kind: "stage.started", payload: { stage: "plan" } },
    history,
    4
  );
  history = retainRunEventHistory(
    { event_id: "stage-collect", sequence: 2, run_id: current.id, kind: "stage.started", payload: { stage: "collect" } },
    history,
    4
  );
  for (let index = 0; index < 12; index += 1) {
    history = retainRunEventHistory(
      { event_id: `artifact-${index}`, sequence: index + 3, run_id: current.id, kind: "artifact.published" },
      history,
      4
    );
  }

  assert.ok(history.length <= 8);
  assert.equal(stageState("plan", current, history), "complete");
  assert.equal(stageState("collect", current, history), "waiting");
});

test("activity history de-duplicates an SSE replay", () => {
  const event: RunEvent = { event_id: "event-1", run_id: "run_1", kind: "artifact.published" };
  const history = retainRunEventHistory(event, retainRunEventHistory(event, []));
  assert.equal(history.length, 1);
});
