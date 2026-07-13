import { describe, expect, it } from "vitest";
import { SseRuntimeDiagnostics } from "./sseRuntimeDiagnostics.js";

describe("SseRuntimeDiagnostics", () => {
  it("keeps only bounded process-wide aggregates", () => {
    const diagnostics = new SseRuntimeDiagnostics();
    diagnostics.recordConnectionOpened();
    diagnostics.recordConnectionOpened();
    diagnostics.adjustBuffered(2, 100);
    diagnostics.adjustBuffered(1, 50);
    diagnostics.adjustBuffered(-3, -150);
    diagnostics.recordSlowConsumerDisconnect();
    diagnostics.recordReplay(3, 7);
    diagnostics.recordReplay(2, 5);
    diagnostics.recordConnectionClosed();

    const snapshot = diagnostics.snapshot();
    expect(snapshot).toEqual({
      activeConnectionCount: 1,
      bufferedEventCount: 0,
      bufferedBytes: 0,
      peakBufferedEventCount: 3,
      peakBufferedBytes: 150,
      slowConsumerDisconnectCount: 1,
      replayCount: 2,
      replayedEventCount: 5,
      replayTotalDurationMs: 12,
      replayMaxDurationMs: 7,
      replayLastDurationMs: 5
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/project|job|url|prompt|secret/i);
  });
});
