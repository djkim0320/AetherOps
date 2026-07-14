import { hashCanonical, serializeCanonical } from "./canonical.js";
import { HarnessError } from "./errors.js";
import { TraceEventSchema, type TraceEvent } from "./traceSchemas.js";

export interface NormalizedTraceDelivery {
  events: TraceEvent[];
  duplicateDeliveries: number;
}

export type TraceEventHashInput = TraceEvent extends infer Event ? (Event extends TraceEvent ? Omit<Event, "eventHash"> : never) : never;

export async function computeTraceEventHash(event: TraceEventHashInput): Promise<string> {
  return hashCanonical(event);
}

export function normalizeAtLeastOnceTraceDelivery(input: readonly unknown[]): NormalizedTraceDelivery {
  const events = input.map((event) => TraceEventSchema.parse(event));
  const normalized: TraceEvent[] = [];
  const byEventId = new Map<string, string>();
  let duplicateDeliveries = 0;
  for (const event of events) {
    const serialized = serializeCanonical(event);
    const existing = byEventId.get(event.eventId);
    if (existing !== undefined) {
      if (existing !== serialized) invalid(`At-least-once delivery changed duplicate event: ${event.eventId}`);
      duplicateDeliveries += 1;
      continue;
    }
    if (normalized.length && event.sequence <= normalized.at(-1)!.sequence) invalid(`At-least-once delivery is out of order at sequence ${event.sequence}.`);
    byEventId.set(event.eventId, serialized);
    normalized.push(event);
  }
  return { events: normalized, duplicateDeliveries };
}

export async function validateTraceEnvelope(events: TraceEvent[], requireTerminal: boolean): Promise<void> {
  const eventIds = new Set<string>();
  let previousTimestamp = "";
  let previousHash: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence !== index + 1) invalid(`Trace sequence must be contiguous from 1; received ${event.sequence} at index ${index}.`);
    if (index > 0 && event.runId !== events[0]!.runId) invalid("Trace contains multiple run IDs.");
    if (index > 0 && event.caseId !== events[0]!.caseId) invalid("Trace contains multiple eval case IDs.");
    if (index > 0 && event.projectId !== events[0]!.projectId) invalid("Trace contains multiple project IDs.");
    if (index > 0 && event.jobId !== events[0]!.jobId) invalid("Trace contains multiple job IDs.");
    if (eventIds.has(event.eventId)) invalid(`Trace event ID is duplicated: ${event.eventId}`);
    if (new Set(event.dependsOn).size !== event.dependsOn.length) invalid(`Trace dependency is duplicated on event: ${event.eventId}`);
    for (const dependency of event.dependsOn) if (!eventIds.has(dependency)) invalid(`Trace dependency does not reference an earlier event: ${dependency}`);
    if (event.type === "acceptance.checked") {
      for (const evidenceEventId of event.data.evidenceEventIds)
        if (!eventIds.has(evidenceEventId)) invalid(`Acceptance evidence does not reference an earlier same-run event: ${evidenceEventId}`);
    }
    if (previousTimestamp && event.timestamp < previousTimestamp) invalid(`Trace timestamp regressed at sequence ${event.sequence}.`);
    if (event.previousEventHash !== previousHash) invalid(`Trace hash chain is broken at sequence ${event.sequence}.`);
    const { eventHash, ...hashInput } = event;
    const computedHash = await computeTraceEventHash(hashInput);
    if (eventHash !== computedHash) invalid(`Trace event hash mismatch at sequence ${event.sequence}.`);
    previousTimestamp = event.timestamp;
    previousHash = event.eventHash;
    eventIds.add(event.eventId);
  }
  if (events[0]?.type !== "task.created") invalid("Trace must begin with task.created.");
  if (events.filter((event) => event.type === "task.created").length !== 1) invalid("Trace must contain exactly one task.created event.");
  const terminalCount = events.filter((event) => event.type === "eval.completed").length;
  if (requireTerminal && (events.at(-1)?.type !== "eval.completed" || terminalCount !== 1)) invalid("Trace must end with exactly one eval.completed event.");
  if (!requireTerminal && terminalCount !== 0) invalid("A trace prefix cannot contain eval.completed.");
}

export async function validateTraceContentBindings(events: TraceEvent[]): Promise<void> {
  for (const event of events) {
    if (event.type !== "memory.candidate.created") continue;
    const expected = await hashCanonical({ candidateId: event.data.candidateId, sourceArtifactIds: event.data.sourceArtifactIds });
    if (event.data.contentHash !== expected) invalid(`Memory candidate content hash mismatch: ${event.data.candidateId}`);
  }
}

function invalid(message: string): never {
  throw new HarnessError("TRACE_INVALID", message);
}
