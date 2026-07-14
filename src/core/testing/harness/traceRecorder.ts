import { DeterministicClock, DeterministicIdGenerator } from "./deterministicPrimitives.js";
import { TraceEventSchema, type TraceEvent, type TraceEventType } from "./traceSchemas.js";
import { computeTraceEventHash, type TraceEventHashInput } from "./traceIntegrity.js";

export class DeterministicTraceRecorder {
  private readonly recorded: TraceEvent[] = [];
  private previousEventHash: string | null = null;

  constructor(
    readonly runId: string,
    readonly caseId: string,
    readonly projectId: string,
    readonly jobId: string,
    private readonly clock: DeterministicClock,
    private readonly ids: DeterministicIdGenerator
  ) {}

  async emit(type: TraceEventType, data: unknown, dependsOn?: readonly string[]): Promise<TraceEvent> {
    const previous = this.recorded.at(-1);
    const hashInput = {
      schemaVersion: 1 as const,
      eventId: this.ids.nextUuid(),
      runId: this.runId,
      caseId: this.caseId,
      projectId: this.projectId,
      jobId: this.jobId,
      sequence: this.recorded.length + 1,
      timestamp: this.clock.nowIso(),
      dependsOn: dependsOn ? [...dependsOn] : previous ? [previous.eventId] : [],
      previousEventHash: this.previousEventHash,
      type,
      data
    } as TraceEventHashInput;
    const event = TraceEventSchema.parse({ ...hashInput, eventHash: await computeTraceEventHash(hashInput) });
    this.recorded.push(event);
    this.previousEventHash = event.eventHash;
    return event;
  }

  events(): TraceEvent[] {
    return [...this.recorded];
  }
}
