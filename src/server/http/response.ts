import { type ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload)}\n`);
}

export function sendText(response: ServerResponse, status: number, payload: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(payload);
}

export function writeSseEvent(
  response: ServerResponse,
  event: { id: number; type: string; data: unknown; occurredAt?: string; projectId?: string; projectRevision?: number }
): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function writeSseHeartbeat(response: ServerResponse): void {
  response.write(": heartbeat\n\n");
}

export function setSseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders?.();
}
