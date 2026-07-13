import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";
import { requiredNumber, requiredString, type Row } from "./repositorySupport.js";
import { rowToCodexCliExecution, rowToLlmInvocation, rowToNetworkAudit, rowToOutputLink, rowToToolAttempt, rowToToolDecision } from "./traceMappers.js";
import type { StorageTraceCategory, StorageTraceItemByCategory, StorageTracePage, StorageTraceSummary } from "./traceTypes.js";

const MAX_TRACE_PAGE_SIZE = 200;

interface TraceCategoryQuery {
  table: string;
  timestampColumn: string;
}

interface TraceCursor {
  version: 1;
  jobId: string;
  category: StorageTraceCategory;
  timestamp: string;
  id: string;
}

const categoryQueries: Record<StorageTraceCategory, TraceCategoryQuery> = {
  llmInvocations: { table: "llm_invocations", timestampColumn: "started_at" },
  toolDecisions: { table: "tool_decisions", timestampColumn: "created_at" },
  toolAttempts: { table: "tool_attempts", timestampColumn: "queued_at" },
  codexCliExecutions: { table: "codex_cli_executions", timestampColumn: "created_at" },
  outputs: { table: "tool_output_links", timestampColumn: "created_at" },
  networkAudits: { table: "network_audits", timestampColumn: "audited_at" }
};

export class TracePaginationRepository {
  constructor(private readonly db: DatabaseSync) {}

  summaryJob(jobId: string): StorageTraceSummary {
    const row = this.db
      .prepare(
        `select
          (select count(*) from llm_invocations where job_id=?) as llm_invocations,
          (select count(*) from tool_decisions where job_id=?) as tool_decisions,
          (select count(*) from tool_attempts where job_id=?) as tool_attempts,
          (select count(*) from codex_cli_executions where job_id=?) as codex_cli_executions,
          (select count(*) from tool_output_links where job_id=?) as outputs,
          (select count(*) from network_audits where job_id=?) as network_audits`
      )
      .get(jobId, jobId, jobId, jobId, jobId, jobId) as Row;
    const counts = {
      llmInvocations: requiredNumber(row.llm_invocations, "trace.summary.llmInvocations"),
      toolDecisions: requiredNumber(row.tool_decisions, "trace.summary.toolDecisions"),
      toolAttempts: requiredNumber(row.tool_attempts, "trace.summary.toolAttempts"),
      codexCliExecutions: requiredNumber(row.codex_cli_executions, "trace.summary.codexCliExecutions"),
      outputs: requiredNumber(row.outputs, "trace.summary.outputs"),
      networkAudits: requiredNumber(row.network_audits, "trace.summary.networkAudits")
    };
    return { jobId, counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) };
  }

  pageJob<C extends StorageTraceCategory>(jobId: string, category: C, cursor?: string, limit?: number): StorageTracePage<C> {
    const query = categoryQueries[category];
    if (!query) throw new Error(`Unsupported trace category: ${String(category)}.`);
    const pageSize = normalizeTracePageLimit(limit);
    const position = cursor ? decodeCursor(cursor, jobId, category) : undefined;
    if (position && !this.cursorAnchorExists(jobId, query, position)) throw new InvalidTraceCursorError();
    const rows = this.queryRows(jobId, query, position, pageSize + 1);
    const truncated = rows.length > pageSize;
    const pageRows = truncated ? rows.slice(0, pageSize) : rows;
    const items = mapRows(category, pageRows);
    const itemCursors = pageRows.map((row) =>
      encodeCursor(jobId, category, requiredString(row[query.timestampColumn], "trace.cursor.timestamp"), requiredString(row.id, "trace.cursor.id"))
    );
    const total = this.countRows(jobId, query.table);
    const last = truncated ? pageRows.at(-1) : undefined;
    return {
      category,
      order: "newest_first",
      items,
      itemCursors,
      total,
      nextCursor: last
        ? encodeCursor(jobId, category, requiredString(last[query.timestampColumn], "trace.cursor.timestamp"), requiredString(last.id, "trace.cursor.id"))
        : undefined,
      truncated
    };
  }

  private queryRows(jobId: string, query: TraceCategoryQuery, cursor: TraceCursor | undefined, limit: number): Row[] {
    if (!cursor) {
      return this.db.prepare(`select * from ${query.table} where job_id=? order by ${query.timestampColumn} desc, id desc limit ?`).all(jobId, limit) as Row[];
    }
    return this.db
      .prepare(
        `select * from ${query.table} where job_id=?
         and (${query.timestampColumn} < ? or (${query.timestampColumn} = ? and id < ?))
         order by ${query.timestampColumn} desc, id desc limit ?`
      )
      .all(jobId, cursor.timestamp, cursor.timestamp, cursor.id, limit) as Row[];
  }

  private countRows(jobId: string, table: string): number {
    const row = this.db.prepare(`select count(*) as total from ${table} where job_id=?`).get(jobId) as Row;
    return requiredNumber(row.total, "trace.page.total");
  }

  private cursorAnchorExists(jobId: string, query: TraceCategoryQuery, cursor: TraceCursor): boolean {
    return Boolean(
      this.db.prepare(`select 1 from ${query.table} where job_id=? and id=? and ${query.timestampColumn}=?`).get(jobId, cursor.id, cursor.timestamp)
    );
  }
}

function normalizeTracePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0) || !limit || limit < 1) return 100;
  return Math.min(Math.floor(limit), MAX_TRACE_PAGE_SIZE);
}

function encodeCursor(jobId: string, category: StorageTraceCategory, timestamp: string, id: string): string {
  const cursor: TraceCursor = { version: 1, jobId, category, timestamp, id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, jobId: string, category: StorageTraceCategory): TraceCursor {
  try {
    if (!cursor || cursor.length > 2_048) throw new Error("Trace cursor length is invalid.");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<TraceCursor>;
    if (
      value.version !== 1 ||
      value.jobId !== jobId ||
      value.category !== category ||
      typeof value.timestamp !== "string" ||
      !value.timestamp ||
      typeof value.id !== "string" ||
      !value.id
    ) {
      throw new Error("Invalid trace cursor payload.");
    }
    return value as TraceCursor;
  } catch (error) {
    throw new InvalidTraceCursorError(error);
  }
}

export class InvalidTraceCursorError extends Error {
  constructor(cause?: unknown) {
    super("Invalid trace pagination cursor.", cause === undefined ? undefined : { cause });
    this.name = "InvalidTraceCursorError";
  }
}

function mapRows<C extends StorageTraceCategory>(category: C, rows: Row[]): Array<StorageTraceItemByCategory[C]> {
  switch (category) {
    case "llmInvocations":
      return rows.map(rowToLlmInvocation) as Array<StorageTraceItemByCategory[C]>;
    case "toolDecisions":
      return rows.map(rowToToolDecision) as Array<StorageTraceItemByCategory[C]>;
    case "toolAttempts":
      return rows.map(rowToToolAttempt) as Array<StorageTraceItemByCategory[C]>;
    case "codexCliExecutions":
      return rows.map(rowToCodexCliExecution) as Array<StorageTraceItemByCategory[C]>;
    case "outputs":
      return rows.map(rowToOutputLink) as Array<StorageTraceItemByCategory[C]>;
    case "networkAudits":
      return rows.map(rowToNetworkAudit) as Array<StorageTraceItemByCategory[C]>;
  }
}
