import { Buffer } from "node:buffer";
import { TRACE_CATEGORIES_V2, TRACE_MAX_SERIALIZED_BYTES, type JobDetail } from "../../../contracts/api-v2/jobs.js";
import type { DurableTraceContinuationCursors } from "../../composition/durableJobTypes.js";

const SERIALIZATION_HEADROOM_BYTES = 8_192;
type TraceCategory = (typeof TRACE_CATEGORIES_V2)[number];

/** Keeps newest-first prefixes and exposes an anchored continuation cursor for every trimmed page. */
export function fitJobDetailToSerializedBudget(response: JobDetail, cursors?: DurableTraceContinuationCursors): JobDetail {
  let serializedBytes = bytes(response);
  if (serializedBytes <= TRACE_MAX_SERIALIZED_BYTES) return response;
  if (!cursors) throw new Error("Durable trace continuation cursors are unavailable for byte-budget pagination.");

  const bounded = cloneResponse(response);
  const target = TRACE_MAX_SERIALIZED_BYTES - SERIALIZATION_HEADROOM_BYTES;
  while (serializedBytes > target) {
    const removedBytes = removeLargestTail(bounded, cursors);
    if (removedBytes === undefined) break;
    serializedBytes -= removedBytes;
  }
  refreshMetadata(bounded, response, cursors);
  serializedBytes = bytes(bounded);
  while (serializedBytes > TRACE_MAX_SERIALIZED_BYTES) {
    if (removeLargestTail(bounded, cursors) === undefined) {
      throw new Error("Serialized trace response cannot fit its budget while retaining continuation anchors.");
    }
    refreshMetadata(bounded, response, cursors);
    serializedBytes = bytes(bounded);
  }
  return bounded;
}

function cloneResponse(response: JobDetail): JobDetail {
  return {
    ...response,
    trace: {
      ...response.trace,
      llmInvocations: [...response.trace.llmInvocations],
      toolDecisions: [...response.trace.toolDecisions],
      toolAttempts: [...response.trace.toolAttempts],
      codexCliExecutions: [...response.trace.codexCliExecutions],
      outputs: [...response.trace.outputs],
      networkAudits: [...response.trace.networkAudits],
      pages: Object.fromEntries(TRACE_CATEGORIES_V2.map((category) => [category, { ...response.trace.pages[category] }])) as JobDetail["trace"]["pages"],
      budget: { ...response.trace.budget }
    }
  };
}

function removeLargestTail(response: JobDetail, cursors: DurableTraceContinuationCursors): number | undefined {
  const arrays = traceArrays(response);
  const candidate = TRACE_CATEGORIES_V2.map((category, ordinal) => {
    const items = arrays[category];
    const newLength = items.length - 1;
    if (newLength < 1 || !cursors[category][newLength - 1]) return undefined;
    return { category, ordinal, bytes: bytes(items.at(-1)) };
  })
    .filter((value): value is { category: TraceCategory; ordinal: number; bytes: number } => Boolean(value))
    .sort((left, right) => right.bytes - left.bytes || left.ordinal - right.ordinal)[0];
  if (!candidate) return undefined;
  arrays[candidate.category].pop();
  return candidate.bytes;
}

function refreshMetadata(response: JobDetail, original: JobDetail, cursors: DurableTraceContinuationCursors): void {
  const arrays = traceArrays(response);
  const originalArrays = traceArrays(original);
  let returned = 0;
  for (const category of TRACE_CATEGORIES_V2) {
    const length = arrays[category].length;
    returned += length;
    if (length >= originalArrays[category].length) continue;
    const nextCursor = cursors[category][length - 1];
    if (!nextCursor) throw new Error(`Durable trace continuation cursor is missing for ${category}.`);
    response.trace.pages[category] = { ...original.trace.pages[category], returned: length, truncated: true, nextCursor };
  }
  response.trace.budget = {
    ...original.trace.budget,
    returned,
    truncated: returned < response.trace.summary.total || TRACE_CATEGORIES_V2.some((category) => response.trace.pages[category].truncated)
  };
}

function traceArrays(response: JobDetail): Record<TraceCategory, unknown[]> {
  return response.trace as unknown as Record<TraceCategory, unknown[]>;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
