export class AutonomyRpcClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async rpc(method, params, timeoutMs = 60_000) {
    const response = await fetch(`${this.baseUrl}/api/v2/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AetherOps-Rpc-Token": this.token },
      body: JSON.stringify({ requestId: `autonomy-${crypto.randomUUID()}`, method, params }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json();
    if (!response.ok || !body?.ok) {
      const error = new Error(body?.error?.message ?? `RPC ${method} failed with HTTP ${response.status}.`);
      error.code = body?.error?.code ?? `HTTP_${response.status}`;
      error.details = body?.error?.details;
      throw error;
    }
    return body.result;
  }

  async health(timeoutMs = 5_000) {
    const response = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}.`);
    return response.json();
  }

  async collectJobEvents(projectId, jobId, timeoutMs, onEvent) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`SSE timed out after ${timeoutMs}ms.`)), timeoutMs);
    const events = [];
    try {
      const url = new URL(`${this.baseUrl}/api/v2/events`);
      url.searchParams.set("projectId", projectId);
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream", "Last-Event-ID": "0", "X-AetherOps-Rpc-Token": this.token },
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`SSE endpoint returned HTTP ${response.status}.`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const next = await reader.read();
        if (next.done) throw new Error(`SSE disconnected before job ${jobId} reached a terminal status.`);
        buffer += next.value.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const event = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (event) {
            events.push(event);
            await onEvent?.(event);
            if (isTerminalJobEvent(event, jobId)) return events;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}

function parseFrame(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isTerminalJobEvent(event, jobId) {
  return (
    event.type === "run.status.changed" &&
    event.data?.jobId === jobId &&
    ["paused", "aborted", "interrupted", "blocked", "failed", "completed"].includes(event.data.status)
  );
}
