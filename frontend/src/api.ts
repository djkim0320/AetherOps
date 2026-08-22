export class ApiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

type JsonRecord = Record<string, unknown>;

const shellToken = (() => {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = fragment.get("access_token") ?? "";
  if (token) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return token;
})();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromPayload(payload: unknown, status: number): ApiError {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string"
      ? payload.error.message
      : `요청이 실패했습니다. (HTTP ${status})`;
    const code = typeof payload.error.code === "string" ? payload.error.code : undefined;
    return new ApiError(message, { status, code });
  }
  return new ApiError(`요청이 실패했습니다. (HTTP ${status})`, { status });
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
		...(shellToken ? { Authorization: `Bearer ${shellToken}` } : {}),
        ...init.headers
      }
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "알 수 없는 네트워크 오류";
    throw new ApiError(`AetherOps 핵심 서비스에 연결할 수 없습니다: ${detail}`);
  }

  const payload = await parseResponse(response);
  if (!response.ok) {
    throw errorFromPayload(payload, response.status);
  }
  return payload as T;
}

export function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function del<T>(path: string, body?: unknown): Promise<T> {
	return request<T>(path, {
		method: "DELETE",
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

export type ArtifactResponse = {
	blob: Blob;
	filename: string;
	mediaType: string;
	sha256: string;
	size: number;
	verified: true;
	binary: boolean;
	text?: string;
	json?: unknown;
};

export async function fetchArtifact(path: string, binaryHint = false): Promise<ArtifactResponse> {
	let response: Response;
	try {
		response = await fetch(path, {
			headers: {
				Accept: "*/*",
				...(shellToken ? { Authorization: `Bearer ${shellToken}` } : {})
			}
		});
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : "알 수 없는 네트워크 오류";
		throw new ApiError(`산출물을 내려받을 수 없습니다: ${detail}`);
	}
	if (!response.ok) {
		throw errorFromPayload(await parseResponse(response), response.status);
	}
	const expectedHash = (response.headers.get("X-Content-SHA256") ?? "").trim().toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
		throw new ApiError("산출물 응답에 유효한 SHA-256 검증값이 없습니다.");
	}
	if (!window.crypto?.subtle) {
		throw new ApiError("이 WebView에서는 산출물 SHA-256 검증을 수행할 수 없습니다.");
	}
	const blob = await response.blob();
	const digest = await window.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
	const actualHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
	if (actualHash !== expectedHash) {
		throw new ApiError(`산출물 무결성 검증에 실패했습니다. (예상 ${expectedHash}, 실제 ${actualHash})`);
	}
	const mediaType = (response.headers.get("Content-Type") ?? blob.type ?? "application/octet-stream")
		.split(";", 1)[0]
		.trim()
		.toLowerCase();
	const filename = artifactFilename(response.headers.get("Content-Disposition"));
	const binary = binaryHint || !isTextMediaType(mediaType);
	let text: string | undefined;
	let json: unknown;
	if (!binary) {
		text = await blob.text();
		if (mediaType === "application/json" || mediaType.endsWith("+json")) {
			try {
				json = JSON.parse(text) as unknown;
				text = JSON.stringify(json, null, 2);
			} catch {
				// Preserve malformed JSON verbatim so the user can inspect the artifact.
			}
		}
	}
	return {
		blob,
		filename,
		mediaType,
		sha256: expectedHash,
		size: blob.size,
		verified: true,
		binary,
		...(text === undefined ? {} : { text }),
		...(json === undefined ? {} : { json })
	};
}

function isTextMediaType(mediaType: string): boolean {
	return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json") ||
		mediaType === "application/xml" || mediaType.endsWith("+xml") || mediaType === "application/javascript";
}

function artifactFilename(disposition: string | null): string {
	let candidate = "aetherops-artifact.bin";
	if (disposition) {
		const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition)?.[1];
		const plain = /filename\s*=\s*"([^"]+)"/i.exec(disposition)?.[1] ??
			/filename\s*=\s*([^;]+)/i.exec(disposition)?.[1];
		try {
			candidate = encoded ? decodeURIComponent(encoded.trim()) : (plain?.trim() || candidate);
		} catch {
			candidate = plain?.trim() || candidate;
		}
	}
	const safe = candidate.replace(/[\\/\0-\x1f<>:"|?*]/g, "-").replace(/^\.+/, "").trim();
	return safe || "aetherops-artifact.bin";
}

export function listFrom<T>(payload: unknown, preferredKey: string): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (!isRecord(payload)) {
    return [];
  }
  const candidates = [payload[preferredKey], payload.items, payload.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate as T[];
    }
  }
  return [];
}

export function objectFrom(payload: unknown, preferredKey?: string): JsonRecord | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (preferredKey && isRecord(payload[preferredKey])) {
    return payload[preferredKey];
  }
  return payload;
}

export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}

export type RunEvent = {
  event_id?: string | number;
  id?: string | number;
  sequence?: string | number;
  run_id?: string;
  kind?: string;
  payload?: unknown;
  created_at?: string;
};

export function subscribeToRunEvents(
  after: string,
  onEvent: (event: RunEvent) => void,
  onConnectionIssue: (message: string) => void
): () => void {
	const controller = new AbortController();
	void consumeRunEvents(after, controller.signal, onEvent, onConnectionIssue);
	return () => controller.abort();
}

async function consumeRunEvents(
	after: string,
	signal: AbortSignal,
	onEvent: (event: RunEvent) => void,
	onConnectionIssue: (message: string) => void
): Promise<void> {
	let cursor = after;
	while (!signal.aborted) {
		try {
			const params = new URLSearchParams({ after: cursor });
			const response = await fetch(`/api/v1/events?${params.toString()}`, {
				signal,
				headers: {
					Accept: "text/event-stream",
					...(shellToken ? { Authorization: `Bearer ${shellToken}` } : {})
				}
			});
			if (!response.ok || !response.body) {
				throw new ApiError(`실시간 연결이 실패했습니다. (HTTP ${response.status})`, { status: response.status });
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
				let boundary = buffered.indexOf("\n\n");
				while (boundary >= 0) {
					const frame = buffered.slice(0, boundary);
					buffered = buffered.slice(boundary + 2);
					const parsed = parseSSEFrame(frame);
					if (parsed?.event === "run_event" && parsed.data) {
						const event = JSON.parse(parsed.data) as RunEvent;
						onEvent(event);
						if (parsed.id) cursor = parsed.id;
					}
					boundary = buffered.indexOf("\n\n");
				}
			}
			if (!signal.aborted) throw new Error("실시간 연결이 종료되었습니다.");
		} catch (error) {
			if (signal.aborted) return;
			onConnectionIssue(error instanceof SyntaxError
				? "실시간 이벤트 형식을 읽을 수 없습니다."
				: "실시간 연결이 끊겼습니다. 다시 연결을 시도하고 있습니다.");
			await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
		}
	}
}

function parseSSEFrame(frame: string): { event: string; id: string; data: string } | null {
	let event = "message";
	let id = "";
	const data: string[] = [];
	for (const line of frame.split("\n")) {
		if (!line || line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "event") event = value;
		else if (field === "id") id = value;
		else if (field === "data") data.push(value);
	}
	return data.length ? { event, id, data: data.join("\n") } : null;
}
