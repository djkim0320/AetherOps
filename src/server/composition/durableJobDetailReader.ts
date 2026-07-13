import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { StorageTraceCategory, StorageTracePage, StorageTraceSummary } from "../runtime/storage/v2/traceTypes.js";
import { STORAGE_TRACE_CATEGORIES } from "../runtime/storage/v2/traceTypes.js";
import {
  DURABLE_TRACE_MAX_RECORDS,
  DURABLE_TRACE_MAX_SERIALIZED_BYTES,
  DURABLE_TRACE_PREVIEW_LIMIT,
  type DurableJobDetail,
  type DurableJobRecord,
  type DurableTraceContinuationCursors,
  type DurableTracePageRequest,
  type DurableTracePages
} from "./durableJobTypes.js";

export async function readDurableJobDetail(client: StorageWorkerClient, job: DurableJobRecord, request?: DurableTracePageRequest): Promise<DurableJobDetail> {
  assertTracePageRequest(request);
  const summaryRequest = client.request<StorageTraceSummary>({ name: "trace.summaryJob", jobId: job.id });
  const pageRequests = STORAGE_TRACE_CATEGORIES.map((category) => readCategoryPage(client, job.id, category, request));
  const [summary, pages] = await Promise.all([summaryRequest, Promise.all(pageRequests)]);
  const byCategory = Object.fromEntries(pages.map((page) => [page.category, page])) as TracePageRecord;
  const tracePages = pageMetadata(byCategory);
  const returned = STORAGE_TRACE_CATEGORIES.reduce((total, category) => total + byCategory[category].items.length, 0);
  if (returned > DURABLE_TRACE_MAX_RECORDS) throw new Error("Durable trace record budget exceeded.");
  return {
    ...job,
    traceAvailability: job.requestHash || summary.total > 0 ? "available" : "legacy_unavailable",
    traceSummary: summary,
    tracePages,
    traceContinuationCursors: continuationCursors(byCategory),
    traceBudget: {
      maxRecords: DURABLE_TRACE_MAX_RECORDS,
      maxSerializedBytes: DURABLE_TRACE_MAX_SERIALIZED_BYTES,
      returned,
      total: summary.total,
      truncated: returned < summary.total || STORAGE_TRACE_CATEGORIES.some((category) => byCategory[category].truncated)
    },
    trace: {
      llmInvocations: byCategory.llmInvocations.items,
      toolDecisions: byCategory.toolDecisions.items,
      toolAttempts: byCategory.toolAttempts.items,
      codexCliExecutions: byCategory.codexCliExecutions.items,
      outputs: byCategory.outputs.items,
      networkAudits: byCategory.networkAudits.items
    }
  };
}

type TracePageRecord = { [C in StorageTraceCategory]: StorageTracePage<C> };

function readCategoryPage<C extends StorageTraceCategory>(
  client: StorageWorkerClient,
  jobId: string,
  category: C,
  request: DurableTracePageRequest | undefined
): Promise<StorageTracePage<C>> {
  const selected = request?.category === category ? request : undefined;
  return client.request({
    name: "trace.pageJob",
    jobId,
    category,
    ...(selected?.cursor ? { cursor: selected.cursor } : {}),
    limit: selected?.limit ?? DURABLE_TRACE_PREVIEW_LIMIT
  });
}

function pageMetadata(pages: TracePageRecord): DurableTracePages {
  return Object.fromEntries(
    STORAGE_TRACE_CATEGORIES.map((category) => {
      const page = pages[category];
      return [
        category,
        {
          order: page.order,
          total: page.total,
          returned: page.items.length,
          truncated: page.truncated,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        }
      ];
    })
  ) as DurableTracePages;
}

function continuationCursors(pages: TracePageRecord): DurableTraceContinuationCursors {
  return Object.fromEntries(STORAGE_TRACE_CATEGORIES.map((category) => [category, pages[category].itemCursors])) as DurableTraceContinuationCursors;
}

function assertTracePageRequest(request: DurableTracePageRequest | undefined): void {
  if (!request) return;
  if (!STORAGE_TRACE_CATEGORIES.includes(request.category)) throw new Error("Unsupported durable trace category.");
  if (request.cursor !== undefined && (!/^[A-Za-z0-9_-]+$/.test(request.cursor) || request.cursor.length > 2_048)) {
    throw new Error("Invalid durable trace cursor.");
  }
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 200)) {
    throw new Error("Invalid durable trace page limit.");
  }
}
