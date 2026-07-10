import { z } from "zod";
import { RpcErrorResponseSchema, RpcRequestV2Schema } from "../../contracts/api-v2/common.js";

const configuredBase = import.meta.env.VITE_AETHEROPS_API_URL?.trim();
const baseUrl = configuredBase ? configuredBase.replace(/\/+$/, "") : window.location.origin;
const endpoint = new URL("/api/v2/rpc", baseUrl).toString();

export class RpcClientError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "RpcClientError";
  }
}

export async function callRpc<T>(method: string, params: unknown, resultSchema: z.ZodType<T>): Promise<T> {
  const request = RpcRequestV2Schema.parse({ requestId: crypto.randomUUID(), method, params });
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(request)
  });
  const payload = await readJson(response);
  const failure = RpcErrorResponseSchema.safeParse(payload);
  if (failure.success) {
    throw new RpcClientError(failure.data.error.message, failure.data.error.code, failure.data.error.details);
  }
  if (!response.ok || !payload || typeof payload !== "object" || !("result" in payload)) {
    throw new RpcClientError(`${method} failed with HTTP ${response.status}.`);
  }
  return resultSchema.parse((payload as { result: unknown }).result);
}

export function projectEventsUrl(projectId: string): string {
  const url = new URL("/api/v2/events", baseUrl);
  url.searchParams.set("projectId", projectId);
  return url.toString();
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RpcClientError(`Server returned invalid JSON (${response.status}).`);
  }
}
