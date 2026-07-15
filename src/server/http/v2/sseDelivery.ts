import type { ServerResponse } from "node:http";
import { HttpError } from "../response.js";

export interface SseDeliveryLimits {
  pageSize: number;
  heartbeatMs: number;
  maxBufferedEvents: number;
  maxBufferedBytes: number;
  maxReplayEvents: number;
  maxReplayBytes: number;
  maxReplayDurationMs: number;
  maxDrainDurationMs: number;
}

export const DEFAULT_SSE_LIMITS: SseDeliveryLimits = Object.freeze({
  pageSize: 200,
  heartbeatMs: 15_000,
  maxBufferedEvents: 512,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxReplayEvents: 10_000,
  maxReplayBytes: 32 * 1024 * 1024,
  maxReplayDurationMs: 30_000,
  maxDrainDurationMs: 15_000
});

export class SseDeliveryBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseDeliveryBudgetError";
  }
}

export class SseSlowConsumerError extends SseDeliveryBudgetError {
  constructor(message: string) {
    super(message);
    this.name = "SseSlowConsumerError";
  }
}

export interface SseBufferObserver {
  adjustBuffered(eventDelta: number, byteDelta: number): void;
}

export class SseConnectionLimiter {
  private activeTotal = 0;
  private readonly activeByProject = new Map<string, number>();

  constructor(
    private readonly maxTotal = 64,
    private readonly maxPerProject = 8
  ) {
    if (!Number.isInteger(maxTotal) || maxTotal < 1 || !Number.isInteger(maxPerProject) || maxPerProject < 1) {
      throw new Error("SSE connection limits must be positive integers.");
    }
  }

  acquire(projectId: string): () => void {
    const projectCount = this.activeByProject.get(projectId) ?? 0;
    if (this.activeTotal >= this.maxTotal || projectCount >= this.maxPerProject) {
      throw new HttpError(429, "Too many active event stream connections.");
    }
    this.activeTotal++;
    this.activeByProject.set(projectId, projectCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTotal--;
      const next = (this.activeByProject.get(projectId) ?? 1) - 1;
      if (next > 0) this.activeByProject.set(projectId, next);
      else this.activeByProject.delete(projectId);
    };
  }
}

export function acquireSseConnection(limiter: SseConnectionLimiter, projectId: string, response: ServerResponse): () => void {
  try {
    return limiter.acquire(projectId);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) response.setHeader("Retry-After", "1");
    throw error;
  }
}

interface PendingFrame {
  value: string;
  bytes: number;
  event: boolean;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export class SerializedSseWriter {
  private readonly queue: PendingFrame[] = [];
  private queuedBytes = 0;
  private queuedEvents = 0;
  private pumping = false;
  private closed = false;
  private cancelDrain: ((reason: unknown) => void) | undefined;

  constructor(
    private readonly response: ServerResponse,
    private readonly limits: Pick<SseDeliveryLimits, "maxBufferedEvents" | "maxBufferedBytes" | "maxDrainDurationMs">,
    private readonly observer?: SseBufferObserver
  ) {}

  event(value: { id: number; type: string; [key: string]: unknown }): Promise<void> {
    return this.enqueue(serializeSseEvent(value), true);
  }

  heartbeat(): Promise<void> {
    return this.enqueue(": heartbeat\n\n", false);
  }

  close(reason: unknown = new Error("SSE writer closed.")): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelDrain?.(reason);
    this.cancelDrain = undefined;
    const queued = this.queue.splice(0);
    const queuedBytes = this.queuedBytes;
    const queuedEvents = this.queuedEvents;
    this.queuedBytes = 0;
    this.queuedEvents = 0;
    this.observer?.adjustBuffered(-queuedEvents, -queuedBytes);
    for (const frame of queued) frame.reject(reason);
  }

  private enqueue(value: string, event: boolean): Promise<void> {
    if (this.closed) return Promise.reject(new Error("SSE writer is closed."));
    const bytes = Buffer.byteLength(value, "utf8");
    if (this.queuedBytes + bytes > this.limits.maxBufferedBytes || (event && this.queuedEvents + 1 > this.limits.maxBufferedEvents)) {
      return Promise.reject(new SseSlowConsumerError("SSE connection buffer budget exceeded."));
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ value, bytes, event, resolve, reject });
      this.queuedBytes += bytes;
      if (event) this.queuedEvents++;
      this.observer?.adjustBuffered(event ? 1 : 0, bytes);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        const frame = this.queue[0];
        if (!frame) break;
        if (!this.response.write(frame.value)) await this.waitForDrain();
        if (this.closed) return;
        this.queue.shift();
        this.queuedBytes -= frame.bytes;
        if (frame.event) this.queuedEvents--;
        this.observer?.adjustBuffered(frame.event ? -1 : 0, -frame.bytes);
        frame.resolve();
      }
    } catch (error) {
      this.close(error);
    } finally {
      this.pumping = false;
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.response.off("drain", onDrain);
        this.cancelDrain = undefined;
        if (error === undefined) resolve();
        else reject(error);
      };
      const onDrain = (): void => finish();
      const timeout = setTimeout(() => finish(new SseSlowConsumerError("SSE socket drain deadline exceeded.")), this.limits.maxDrainDurationMs);
      timeout.unref();
      this.cancelDrain = (reason) => finish(reason);
      this.response.once("drain", onDrain);
    });
  }
}

export function serializeSseEvent(event: { id: number; type: string; [key: string]: unknown }): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function serializedSseEventBytes(event: { id: number; type: string; [key: string]: unknown }): number {
  return Buffer.byteLength(serializeSseEvent(event), "utf8");
}

export function parseLastEventId(value: string | string[] | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    throw new HttpError(400, "Last-Event-ID must be a non-negative safe integer.");
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new HttpError(400, "Last-Event-ID must contain exactly one value.");
    return parseLastEventId(value[0]);
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new HttpError(400, "Last-Event-ID must be a decimal integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, "Last-Event-ID exceeds the safe integer range.");
  return parsed;
}

export function resolveSseLimits(input: Partial<SseDeliveryLimits> = {}): SseDeliveryLimits {
  const resolved: SseDeliveryLimits = {
    pageSize: input.pageSize ?? DEFAULT_SSE_LIMITS.pageSize,
    heartbeatMs: input.heartbeatMs ?? DEFAULT_SSE_LIMITS.heartbeatMs,
    maxBufferedEvents: input.maxBufferedEvents ?? DEFAULT_SSE_LIMITS.maxBufferedEvents,
    maxBufferedBytes: input.maxBufferedBytes ?? DEFAULT_SSE_LIMITS.maxBufferedBytes,
    maxReplayEvents: input.maxReplayEvents ?? DEFAULT_SSE_LIMITS.maxReplayEvents,
    maxReplayBytes: input.maxReplayBytes ?? DEFAULT_SSE_LIMITS.maxReplayBytes,
    maxReplayDurationMs: input.maxReplayDurationMs ?? DEFAULT_SSE_LIMITS.maxReplayDurationMs,
    maxDrainDurationMs: input.maxDrainDurationMs ?? DEFAULT_SSE_LIMITS.maxDrainDurationMs
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value < 1 || !Number.isInteger(value)) throw new Error(`Invalid SSE limit ${name}.`);
  }
  return resolved;
}
