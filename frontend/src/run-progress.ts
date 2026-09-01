import type { RunEvent } from "./api";
import type { Run, Stage } from "./types";

export type StageState = "complete" | "active" | "waiting" | "attention";

const stages: Stage[] = ["plan", "collect", "synthesize", "review"];

function eventIdentity(event: RunEvent): string {
  const explicit = event.event_id ?? event.id;
  if (explicit !== undefined) return String(explicit);
  return [event.run_id ?? "", event.sequence ?? "", event.kind ?? "", event.created_at ?? ""].join(":");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stageValue(value: unknown): Stage | null {
  return value === "plan" || value === "collect" || value === "synthesize" || value === "review"
    ? value
    : null;
}

function eventOrder(event: RunEvent, fallback: number): number {
  const sequence = Number(event.sequence ?? event.event_id ?? event.id);
  if (Number.isFinite(sequence)) return sequence;
  const created = Date.parse(event.created_at ?? "");
  return Number.isFinite(created) ? created : fallback;
}

// Keep the activity feed bounded without discarding the stage markers that are
// needed to render terminal and approval-paused progress accurately. SSE can
// replay an event after reconnecting, so this also removes duplicate receipts.
export function retainRunEventHistory(
  event: RunEvent,
  previous: RunEvent[],
  recentLimit = 64
): RunEvent[] {
  const seen = new Set<string>();
  const candidates = [event, ...previous].filter((candidate) => {
    const identity = eventIdentity(candidate);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  const recent = candidates.slice(0, Math.max(1, recentLimit));
  const retainedRunIDs = new Set(recent.map((candidate) => candidate.run_id).filter(Boolean));
  const retainedIdentities = new Set(recent.map(eventIdentity));
  const stageKeys = new Set<string>();
  const preserved: RunEvent[] = [];

  for (const candidate of candidates) {
    if (candidate.kind !== "stage.started" || !candidate.run_id || !retainedRunIDs.has(candidate.run_id)) continue;
    const stage = stageValue(record(candidate.payload)?.stage);
    if (!stage) continue;
    const key = `${candidate.run_id}:${stage}`;
    if (stageKeys.has(key)) continue;
    stageKeys.add(key);
    if (!retainedIdentities.has(eventIdentity(candidate))) preserved.push(candidate);
  }
  return [...recent, ...preserved];
}

export function latestStartedStage(run: Run, events: RunEvent[]): Stage | null {
  let latest: { stage: Stage; order: number } | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.run_id !== run.id || event.kind !== "stage.started") continue;
    const stage = stageValue(record(event.payload)?.stage);
    if (!stage) continue;
    const order = eventOrder(event, index);
    if (!latest || order > latest.order) latest = { stage, order };
  }
  return latest === null ? null : latest.stage;
}

export function currentRunStage(run: Run | null, events: RunEvent[] = []): Stage | null {
  if (!run) return null;
  const explicit = stageValue(run.current_stage);
  if (explicit) return explicit;
  switch (run.status) {
    case "planning":
      return "plan";
    case "collecting":
      return "collect";
    case "synthesizing":
      return "synthesize";
    case "reviewing":
    case "revising":
      return "review";
    case "waiting_approval":
    case "failed":
    case "quality_failed":
    case "cancelled":
    case "interrupted":
    case "uncertain":
      return latestStartedStage(run, events);
    default:
      return null;
  }
}

export function stageState(stage: Stage, run: Run | null, events: RunEvent[] = []): StageState {
  if (!run) return "waiting";
  if (run.status === "succeeded") return "complete";

  const active = currentRunStage(run, events);
  if (!active) return "waiting";
  const activeIndex = stages.indexOf(active);
  const targetIndex = stages.indexOf(stage);
  if (targetIndex < activeIndex) return "complete";
  if (targetIndex > activeIndex) return "waiting";

  if (["failed", "quality_failed", "cancelled", "interrupted", "uncertain"].includes(run.status)) {
    return "attention";
  }
  return run.status === "waiting_approval" ? "waiting" : "active";
}
