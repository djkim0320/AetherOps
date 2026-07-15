import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";
import {
  parseLastEventId,
  resolveSseLimits,
  serializedSseEventBytes,
  SseDeliveryBudgetError,
  SseSlowConsumerError,
  type SseBufferObserver,
  type SseDeliveryLimits
} from "./sseDelivery.js";

export type ProjectEvent = Awaited<ReturnType<DurableJobRuntime["eventsAfter"]>>[number];

export interface ProjectEventSource {
  eventsAfter(projectId: string, lastEventId?: string, limit?: number, signal?: AbortSignal): Promise<ProjectEvent[]>;
  subscribe(listener: (event: ProjectEvent) => void): () => void;
}

export interface ReplaySubscriptionOptions extends Partial<
  Pick<SseDeliveryLimits, "pageSize" | "maxBufferedEvents" | "maxBufferedBytes" | "maxReplayEvents" | "maxReplayBytes" | "maxReplayDurationMs">
> {
  signal?: AbortSignal;
  now?: () => number;
  onError?: (error: Error) => void;
  observer?: SseReplayObserver;
}

export interface SseReplayObserver extends SseBufferObserver {
  recordReplay(eventCount: number, durationMs: number): void;
}

export async function replayThenSubscribe(
  events: ProjectEventSource,
  projectId: string,
  lastEventId: string | number | undefined,
  emit: (event: ProjectEvent) => void | Promise<void>,
  options: ReplaySubscriptionOptions = {}
): Promise<() => void> {
  const limits = replayLimits(options);
  const now = options.now ?? Date.now;
  const localController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, localController.signal]) : localController.signal;
  let lastSequence = parseLastEventId(lastEventId);
  let replaying = true;
  let terminalError: Error | undefined;
  let removeSourceListener: () => void = () => undefined;
  let sourceListenerReady = false;
  let sourceListenerRemoved = false;
  let sourceRemovalRequested = false;
  let bufferedEventCount = 0;
  let bufferedBytes = 0;
  let pendingLiveEvents = 0;
  let pendingLiveBytes = 0;
  let liveChain = Promise.resolve();
  const buffered: ProjectEvent[] = [];
  const bufferedIds = new Set<number>();
  const queuedLiveIds = new Set<number>();

  const removeSource = (): void => {
    if (sourceListenerRemoved) return;
    if (!sourceListenerReady) {
      sourceRemovalRequested = true;
      return;
    }
    sourceListenerRemoved = true;
    removeSourceListener();
  };
  const abort = (): void => removeSource();
  const releaseReplayBuffer = (): void => {
    if (bufferedEventCount || bufferedBytes) options.observer?.adjustBuffered(-bufferedEventCount, -bufferedBytes);
    bufferedEventCount = 0;
    bufferedBytes = 0;
    buffered.length = 0;
    bufferedIds.clear();
  };
  const close = (): void => {
    signal.removeEventListener("abort", abort);
    removeSource();
    releaseReplayBuffer();
    if (!localController.signal.aborted) localController.abort(new Error("SSE replay subscription closed."));
  };
  const fail = (reason: unknown): void => {
    if (terminalError) return;
    terminalError = asError(reason);
    if (!localController.signal.aborted) localController.abort(terminalError);
    removeSource();
    options.onError?.(terminalError);
  };
  const deliverRange = async (stopAt?: number): Promise<void> => {
    const startedAt = now();
    let deliveredEvents = 0;
    let deliveredBytes = 0;
    try {
      while (true) {
        assertActive(signal, terminalError);
        assertReplayDuration(now, startedAt, limits.maxReplayDurationMs);
        const previousSequence = lastSequence;
        const page = await abortable(events.eventsAfter(projectId, String(lastSequence), limits.pageSize, signal), signal);
        assertActive(signal, terminalError);
        let previousPageId = previousSequence;
        let passedStop = false;
        for (const event of page) {
          assertEvent(event, projectId, previousPageId);
          previousPageId = event.id;
          if (stopAt !== undefined && event.id > stopAt) {
            passedStop = true;
            break;
          }
          if (event.id <= lastSequence) continue;
          assertReplayDuration(now, startedAt, limits.maxReplayDurationMs);
          const bytes = serializedSseEventBytes(event);
          if (deliveredEvents >= limits.maxReplayEvents || deliveredBytes + bytes > limits.maxReplayBytes) {
            throw new SseDeliveryBudgetError("SSE replay budget exceeded.");
          }
          await emitWithinReplayBudget(emit, event, signal, now, startedAt, limits.maxReplayDurationMs);
          deliveredEvents++;
          deliveredBytes += bytes;
          lastSequence = event.id;
        }
        if ((stopAt !== undefined && lastSequence >= stopAt) || passedStop || page.length < limits.pageSize) return;
        if (lastSequence === previousSequence) throw new Error("SSE replay page made no sequence progress.");
      }
    } finally {
      options.observer?.recordReplay(deliveredEvents, Math.max(0, now() - startedAt));
    }
  };
  const deliverLive = async (event: ProjectEvent): Promise<void> => {
    assertActive(signal, terminalError);
    if (event.id <= lastSequence) return;
    if (event.id > lastSequence + 1) await deliverRange(event.id);
    if (event.id <= lastSequence) return;
    await emit(event);
    lastSequence = event.id;
  };
  const queueLive = (event: ProjectEvent): void => {
    if (event.id <= lastSequence || queuedLiveIds.has(event.id) || terminalError) return;
    const bytes = serializedSseEventBytes(event);
    if (pendingLiveEvents + 1 > limits.maxBufferedEvents || pendingLiveBytes + bytes > limits.maxBufferedBytes) {
      fail(new SseSlowConsumerError("SSE live delivery buffer budget exceeded."));
      return;
    }
    pendingLiveEvents++;
    pendingLiveBytes += bytes;
    options.observer?.adjustBuffered(1, bytes);
    queuedLiveIds.add(event.id);
    liveChain = liveChain
      .then(() => deliverLive(event))
      .catch(fail)
      .finally(() => {
        pendingLiveEvents--;
        pendingLiveBytes -= bytes;
        options.observer?.adjustBuffered(-1, -bytes);
        queuedLiveIds.delete(event.id);
      });
  };

  removeSourceListener = events.subscribe((event) => {
    try {
      if (event.projectId !== projectId || terminalError) return;
      if (!Number.isSafeInteger(event.id) || event.id < 1) {
        fail(new Error("SSE live delivery received an invalid event ID."));
        return;
      }
      if (event.id <= lastSequence || bufferedIds.has(event.id)) return;
      if (!replaying) {
        queueLive(event);
        return;
      }
      const bytes = serializedSseEventBytes(event);
      if (bufferedEventCount + 1 > limits.maxBufferedEvents || bufferedBytes + bytes > limits.maxBufferedBytes) {
        fail(new SseSlowConsumerError("SSE live replay buffer budget exceeded."));
        return;
      }
      buffered.push(event);
      bufferedIds.add(event.id);
      bufferedEventCount++;
      bufferedBytes += bytes;
      options.observer?.adjustBuffered(1, bytes);
    } catch (error) {
      fail(error);
    }
  });
  sourceListenerReady = true;
  if (sourceRemovalRequested) removeSource();
  signal.addEventListener("abort", abort, { once: true });

  try {
    assertActive(signal, terminalError);
    await deliverRange();
    while (buffered.length) {
      const batch = buffered.splice(0).sort((left, right) => left.id - right.id);
      for (const event of batch) {
        await deliverLive(event);
        bufferedIds.delete(event.id);
        bufferedEventCount--;
        const bytes = serializedSseEventBytes(event);
        bufferedBytes -= bytes;
        options.observer?.adjustBuffered(-1, -bytes);
      }
    }
    replaying = false;
    return close;
  } catch (error) {
    close();
    throw error;
  }
}

function replayLimits(options: ReplaySubscriptionOptions): SseDeliveryLimits {
  return resolveSseLimits({
    pageSize: options.pageSize,
    maxBufferedEvents: options.maxBufferedEvents,
    maxBufferedBytes: options.maxBufferedBytes,
    maxReplayEvents: options.maxReplayEvents,
    maxReplayBytes: options.maxReplayBytes,
    maxReplayDurationMs: options.maxReplayDurationMs
  });
}

function assertEvent(event: ProjectEvent, projectId: string, previousId: number): void {
  if (event.projectId !== projectId) throw new Error("SSE replay returned an event for a different project.");
  if (!Number.isSafeInteger(event.id) || event.id < 1) throw new Error("SSE replay returned an invalid event ID.");
  if (event.id < previousId) throw new Error("SSE replay returned events out of order.");
}

function assertReplayDuration(now: () => number, startedAt: number, maxDurationMs: number): void {
  if (now() - startedAt > maxDurationMs) throw new SseDeliveryBudgetError("SSE replay duration budget exceeded.");
}

function emitWithinReplayBudget(
  emit: (event: ProjectEvent) => void | Promise<void>,
  event: ProjectEvent,
  signal: AbortSignal,
  now: () => number,
  startedAt: number,
  maxDurationMs: number
): Promise<void> {
  const remaining = maxDurationMs - (now() - startedAt);
  if (remaining <= 0) return Promise.reject(new SseDeliveryBudgetError("SSE replay duration budget exceeded."));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new SseDeliveryBudgetError("SSE replay duration budget exceeded.")), remaining);
    timeout.unref();
  });
  const delivery = abortable(
    Promise.resolve().then(() => emit(event)),
    signal
  );
  return Promise.race([delivery, expired]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function assertActive(signal: AbortSignal, terminalError: Error | undefined): void {
  if (terminalError) throw terminalError;
  if (signal.aborted) throw asError(signal.reason ?? new Error("SSE replay aborted."));
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asError(signal.reason ?? new Error("SSE replay aborted.")));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { value: T } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("value" in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };
    const onAbort = (): void => finish({ error: asError(signal.reason ?? new Error("SSE replay aborted.")) });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error })
    );
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
