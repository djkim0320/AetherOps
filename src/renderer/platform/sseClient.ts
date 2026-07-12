import { SseEventSchema, type SseEvent } from "../../contracts/api-v2/events.js";

export type ProjectEventStreamStatus = "connecting" | "open" | "stale" | "reconnecting" | "gap" | "error";
export interface ProjectEventStreamState {
  status: ProjectEventStreamStatus;
  message?: string;
  lastEventId?: number;
  revision?: number;
}
export interface ProjectEventStreamOptions {
  url: string;
  initialRevision?: number;
  onEvent: (event: SseEvent) => void;
  onStateChange: (state: ProjectEventStreamState) => void;
}

const STALE_AFTER_MS = 45_000;

export function connectProjectEventStream(options: ProjectEventStreamOptions): () => void {
  const controller = new AbortController();
  let reconnectTimer: number | undefined;
  let staleTimer: number | undefined;
  let attempt = 0;
  let revision = options.initialRevision ?? 0;
  let lastEventId = 0;

  function state(status: ProjectEventStreamStatus, message?: string): void {
    options.onStateChange({ status, message, lastEventId, revision });
  }
  function armStaleTimer(): void {
    window.clearTimeout(staleTimer);
    staleTimer = window.setTimeout(() => state("stale", "No server heartbeat or event received for 45 seconds."), STALE_AFTER_MS);
  }
  async function connect(): Promise<void> {
    state(attempt ? "reconnecting" : "connecting");
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream", "Cache-Control": "no-cache" };
      if (lastEventId > 0) headers["Last-Event-ID"] = String(lastEventId);
      const response = await fetch(options.url, { credentials: "include", headers, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Event stream failed with HTTP ${response.status}.`);
      attempt = 0;
      state("open");
      armStaleTimer();
      await consumeStream(response.body);
      if (!controller.signal.aborted) scheduleReconnect("Event stream ended.");
    } catch (error) {
      if (!controller.signal.aborted) scheduleReconnect(error instanceof Error ? error.message : "Event stream failed.");
    }
  }
  async function consumeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consumeBlock(block);
    }
  }
  function consumeBlock(block: string): void {
    armStaleTimer();
    if (!block || block.split(/\r?\n/).every((line) => line.startsWith(":"))) return;
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      state("error", "Invalid event payload.");
      return;
    }
    const parsed = SseEventSchema.safeParse(payload);
    if (!parsed.success) {
      state("error", "Event contract validation failed.");
      return;
    }
    const event = parsed.data;
    // Event IDs are globally allocated and can legitimately skip when other projects
    // commit events. Only a project revision jump indicates missing project state.
    if (revision > 0 && event.projectRevision > revision + 1) {
      revision = event.projectRevision;
      lastEventId = event.id;
      state("gap", "Event gap detected; snapshot refresh required.");
      options.onEvent(event);
      return;
    }
    if (event.id <= lastEventId) return;
    revision = Math.max(revision, event.projectRevision);
    lastEventId = event.id;
    options.onEvent(event);
    state("open");
  }
  function scheduleReconnect(message: string): void {
    window.clearTimeout(staleTimer);
    attempt += 1;
    state("reconnecting", `${message} Displayed data may be stale.`);
    reconnectTimer = window.setTimeout(() => void connect(), Math.min(1_000 * 2 ** (attempt - 1), 30_000));
  }
  void connect();
  return () => {
    controller.abort();
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(staleTimer);
  };
}
