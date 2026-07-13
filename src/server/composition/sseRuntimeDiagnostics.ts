export interface SseRuntimeDiagnosticSnapshot {
  activeConnectionCount: number;
  bufferedEventCount: number;
  bufferedBytes: number;
  peakBufferedEventCount: number;
  peakBufferedBytes: number;
  slowConsumerDisconnectCount: number;
  replayCount: number;
  replayedEventCount: number;
  replayTotalDurationMs: number;
  replayMaxDurationMs: number;
  replayLastDurationMs: number;
}

/** Process-local SSE aggregates. Connection and project identifiers are never retained. */
export class SseRuntimeDiagnostics {
  private activeConnections = 0;
  private bufferedEvents = 0;
  private bufferedByteCount = 0;
  private peakBufferedEvents = 0;
  private peakBufferedByteCount = 0;
  private slowConsumerDisconnects = 0;
  private replays = 0;
  private replayedEvents = 0;
  private replayDurationTotal = 0;
  private replayDurationMax = 0;
  private replayDurationLast = 0;

  recordConnectionOpened(): void {
    this.activeConnections = add(this.activeConnections, 1);
  }

  recordConnectionClosed(): void {
    this.activeConnections = add(this.activeConnections, -1);
  }

  adjustBuffered(eventDelta: number, byteDelta: number): void {
    this.bufferedEvents = add(this.bufferedEvents, eventDelta);
    this.bufferedByteCount = add(this.bufferedByteCount, byteDelta);
    this.peakBufferedEvents = Math.max(this.peakBufferedEvents, this.bufferedEvents);
    this.peakBufferedByteCount = Math.max(this.peakBufferedByteCount, this.bufferedByteCount);
  }

  recordSlowConsumerDisconnect(): void {
    this.slowConsumerDisconnects = add(this.slowConsumerDisconnects, 1);
  }

  recordReplay(eventCount: number, durationMs: number): void {
    const normalizedEvents = nonnegative(eventCount);
    const normalizedDuration = nonnegative(durationMs);
    this.replays = add(this.replays, 1);
    this.replayedEvents = add(this.replayedEvents, normalizedEvents);
    this.replayDurationTotal = add(this.replayDurationTotal, normalizedDuration);
    this.replayDurationMax = Math.max(this.replayDurationMax, normalizedDuration);
    this.replayDurationLast = normalizedDuration;
  }

  snapshot(): SseRuntimeDiagnosticSnapshot {
    return {
      activeConnectionCount: this.activeConnections,
      bufferedEventCount: this.bufferedEvents,
      bufferedBytes: this.bufferedByteCount,
      peakBufferedEventCount: this.peakBufferedEvents,
      peakBufferedBytes: this.peakBufferedByteCount,
      slowConsumerDisconnectCount: this.slowConsumerDisconnects,
      replayCount: this.replays,
      replayedEventCount: this.replayedEvents,
      replayTotalDurationMs: this.replayDurationTotal,
      replayMaxDurationMs: this.replayDurationMax,
      replayLastDurationMs: this.replayDurationLast
    };
  }
}

function add(current: number, delta: number): number {
  const normalizedDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, current + normalizedDelta));
}

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}
