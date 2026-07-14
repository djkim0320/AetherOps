import { createHash } from "node:crypto";

interface PublicRpcJobRequest {
  method: string;
  params: unknown;
}

interface DurableEnqueueRequestIdentity {
  projectId: string;
  kind: string;
  idempotencyKey: string;
  requestedCapabilities?: unknown;
  toolPolicy?: unknown;
  resumesJobId?: string;
  resumeCheckpointId?: string;
  payload?: unknown;
}

export function durableJobRequestHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Hash only the parsed public RPC method and params; requestId and all server projections are excluded. */
export function durablePublicJobRequestHash(request: PublicRpcJobRequest): string {
  return durableJobRequestHash({ method: request.method, params: request.params });
}

/** Fallback identity for non-RPC callers. Runtime-derived execution state must never affect idempotency. */
export function durableEnqueueRequestHash(input: DurableEnqueueRequestIdentity): string {
  return durableJobRequestHash({
    projectId: input.projectId,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    requestedCapabilities: input.requestedCapabilities,
    toolPolicy: input.toolPolicy,
    resumesJobId: input.resumesJobId,
    resumeCheckpointId: input.resumeCheckpointId,
    payload: publicPayload(input.kind, input.payload)
  });
}

function publicPayload(kind: string, value: unknown): unknown {
  if (kind !== "research_loop" || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const { canonicalInitializationAnchor: _derivedAnchor, ...payload } = value as Record<string, unknown>;
  void _derivedAnchor;
  return payload;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) output[key] = normalize(entry);
  }
  return output;
}
