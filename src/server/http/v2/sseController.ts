import type { IncomingMessage, ServerResponse } from "node:http";
import type { DurableJobRuntime } from "../../composition/durableJobRuntime.js";

type ProjectEvent = Awaited<ReturnType<DurableJobRuntime["eventsAfter"]>>[number];

export interface ProjectEventSource {
  eventsAfter(projectId: string, lastEventId?: string, limit?: number): Promise<ProjectEvent[]>;
  subscribe(listener: (event: ProjectEvent) => void): () => void;
}

export async function serveProjectEvents(request: IncomingMessage, response: ServerResponse, url: URL, events: ProjectEventSource): Promise<() => void> {
  const projectId = url.searchParams.get("projectId")?.trim();
  if (!projectId) throw new Error("projectId is required for SSE.");
  const lastEventId = request.headers["last-event-id"];
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const unsubscribe = await replayThenSubscribe(events, projectId, Array.isArray(lastEventId) ? lastEventId[0] : lastEventId, (event) =>
    writeEvent(response, event)
  );
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.once("close", close);
  response.once("close", close);
  return close;
}

export async function replayThenSubscribe(
  events: ProjectEventSource,
  projectId: string,
  lastEventId: string | undefined,
  emit: (event: ProjectEvent) => void
): Promise<() => void> {
  let replaying = true;
  const buffered: ProjectEvent[] = [];
  const unsubscribe = events.subscribe((event) => {
    if (event.projectId !== projectId) return;
    if (replaying) buffered.push(event);
    else emit(event);
  });
  try {
    let lastSequence = Number(lastEventId ?? 0);
    const pageSize = 200;
    while (true) {
      const replay = await events.eventsAfter(projectId, String(lastSequence), pageSize);
      for (const event of replay) {
        if (event.id <= lastSequence) continue;
        emit(event);
        lastSequence = event.id;
      }
      if (replay.length < pageSize) break;
    }
    buffered.sort((left, right) => left.id - right.id);
    for (const event of buffered) {
      if (event.id <= lastSequence) continue;
      emit(event);
      lastSequence = event.id;
    }
    replaying = false;
    return unsubscribe;
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

function writeEvent(response: ServerResponse, event: { id: number; type: string; [key: string]: unknown }): void {
  response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
