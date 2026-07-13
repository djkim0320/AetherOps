import type { IncomingMessage, ServerResponse } from "node:http";
import { EntityIdSchema } from "../../../contracts/api-v2/common.js";
import type { SseRuntimeDiagnostics } from "../../composition/sseRuntimeDiagnostics.js";
import { HttpError, setSseHeaders } from "../response.js";
import {
  acquireSseConnection,
  parseLastEventId,
  resolveSseLimits,
  SerializedSseWriter,
  SseConnectionLimiter,
  SseSlowConsumerError,
  type SseDeliveryLimits
} from "./sseDelivery.js";
import { replayThenSubscribe, type ProjectEventSource } from "./sseReplay.js";

export { parseLastEventId, SseConnectionLimiter } from "./sseDelivery.js";
export { replayThenSubscribe } from "./sseReplay.js";
export type { ProjectEventSource, ReplaySubscriptionOptions } from "./sseReplay.js";

export interface ServeProjectEventsOptions extends Partial<SseDeliveryLimits> {
  limiter?: SseConnectionLimiter;
  now?: () => number;
  diagnostics?: SseRuntimeDiagnostics;
}

const defaultConnectionLimiter = new SseConnectionLimiter();

export async function serveProjectEvents(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  events: ProjectEventSource,
  options: ServeProjectEventsOptions = {}
): Promise<() => void> {
  const parsedProjectId = EntityIdSchema.safeParse(url.searchParams.get("projectId"));
  if (!parsedProjectId.success) throw new HttpError(400, "A valid projectId is required for SSE.");
  const projectId = parsedProjectId.data;
  const lastEventId = parseLastEventId(request.headers["last-event-id"]);
  const limits = resolveSseLimits(options);
  const releaseConnection = acquireSseConnection(options.limiter ?? defaultConnectionLimiter, projectId, response);
  options.diagnostics?.recordConnectionOpened();
  const controller = new AbortController();
  const writer = new SerializedSseWriter(response, limits, options.diagnostics);
  let replayUnsubscribe: (() => void) | undefined;
  const heartbeat: { timer?: ReturnType<typeof setInterval> } = {};
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat.timer) clearInterval(heartbeat.timer);
    request.off("close", cleanup);
    request.off("error", terminate);
    response.off("close", cleanup);
    response.off("error", terminate);
    controller.abort(new Error("SSE connection closed."));
    replayUnsubscribe?.();
    writer.close(controller.signal.reason);
    releaseConnection();
    options.diagnostics?.recordConnectionClosed();
  };
  const terminate = (reason: unknown): void => {
    const wasClosed = closed;
    if (!wasClosed && reason instanceof SseSlowConsumerError) options.diagnostics?.recordSlowConsumerDisconnect();
    cleanup();
    if (!wasClosed && !response.destroyed && !response.writableEnded) response.end();
    void reason;
  };

  request.once("close", cleanup);
  request.once("error", terminate);
  response.once("close", cleanup);
  response.once("error", terminate);
  try {
    setSseHeaders(response);
  } catch (error) {
    cleanup();
    throw error;
  }

  heartbeat.timer = setInterval(() => void writer.heartbeat().catch(terminate), limits.heartbeatMs);
  heartbeat.timer.unref();
  const replay = replayThenSubscribe(events, projectId, lastEventId, (event) => writer.event(event), {
    pageSize: limits.pageSize,
    maxBufferedEvents: limits.maxBufferedEvents,
    maxBufferedBytes: limits.maxBufferedBytes,
    maxReplayEvents: limits.maxReplayEvents,
    maxReplayBytes: limits.maxReplayBytes,
    maxReplayDurationMs: limits.maxReplayDurationMs,
    signal: controller.signal,
    now: options.now,
    onError: terminate,
    observer: options.diagnostics
  });
  void replay.then((unsubscribe) => {
    if (closed) unsubscribe();
    else replayUnsubscribe = unsubscribe;
  }, terminate);
  return cleanup;
}
