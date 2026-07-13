export interface StorageTraceQueryDiagnosticSnapshot {
  queryCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  totalRows: number;
  maxRows: number;
  lastRows: number;
}

export interface StorageTransactionDiagnosticSnapshot {
  transactionCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
}

export interface StorageOperationalDiagnosticSnapshot {
  traceQueries: StorageTraceQueryDiagnosticSnapshot;
  storageTransactions: StorageTransactionDiagnosticSnapshot;
}

export interface StorageRuntimeDiagnosticsOptions {
  now?: () => number;
}

/** Worker-local aggregates. No command arguments, IDs, URLs, or payloads are retained. */
export class StorageRuntimeDiagnostics {
  private readonly now: () => number;
  private traceQueries = 0;
  private traceDurationTotal = 0;
  private traceDurationMax = 0;
  private traceDurationLast = 0;
  private traceRowsTotal = 0;
  private traceRowsMax = 0;
  private traceRowsLast = 0;
  private transactions = 0;
  private transactionDurationTotal = 0;
  private transactionDurationMax = 0;
  private transactionDurationLast = 0;

  constructor(options: StorageRuntimeDiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  measureTraceQuery<T>(work: () => T, rows: (result: T) => number): T {
    const startedAt = this.now();
    let returnedRows = 0;
    try {
      const result = work();
      returnedRows = nonnegative(rows(result));
      return result;
    } finally {
      const duration = elapsed(startedAt, this.now());
      this.traceQueries = increment(this.traceQueries);
      this.traceDurationTotal = add(this.traceDurationTotal, duration);
      this.traceDurationMax = Math.max(this.traceDurationMax, duration);
      this.traceDurationLast = duration;
      this.traceRowsTotal = add(this.traceRowsTotal, returnedRows);
      this.traceRowsMax = Math.max(this.traceRowsMax, returnedRows);
      this.traceRowsLast = returnedRows;
    }
  }

  measureTransaction<T>(work: () => T): T {
    const startedAt = this.now();
    try {
      return work();
    } finally {
      const duration = elapsed(startedAt, this.now());
      this.transactions = increment(this.transactions);
      this.transactionDurationTotal = add(this.transactionDurationTotal, duration);
      this.transactionDurationMax = Math.max(this.transactionDurationMax, duration);
      this.transactionDurationLast = duration;
    }
  }

  snapshot(): StorageOperationalDiagnosticSnapshot {
    return {
      traceQueries: {
        queryCount: this.traceQueries,
        totalDurationMs: this.traceDurationTotal,
        maxDurationMs: this.traceDurationMax,
        lastDurationMs: this.traceDurationLast,
        totalRows: this.traceRowsTotal,
        maxRows: this.traceRowsMax,
        lastRows: this.traceRowsLast
      },
      storageTransactions: {
        transactionCount: this.transactions,
        totalDurationMs: this.transactionDurationTotal,
        maxDurationMs: this.transactionDurationMax,
        lastDurationMs: this.transactionDurationLast
      }
    };
  }
}

export function isTraceReadCommand(name: string): boolean {
  return (
    name === "trace.llm.listJob" ||
    name === "trace.decision.listJob" ||
    name === "trace.attempt.get" ||
    name === "trace.attempt.listJob" ||
    name === "trace.codex.listJob" ||
    name === "trace.output.listAttempt" ||
    name === "trace.output.listAttempts" ||
    name === "trace.network.listJob" ||
    name === "trace.summaryJob" ||
    name === "trace.pageJob"
  );
}

export function traceReadResultRows(name: string, result: unknown): number {
  if (name === "trace.summaryJob") return 1;
  if (name === "trace.attempt.get") return result === undefined ? 0 : 1;
  if (name === "trace.pageJob" && isRecord(result) && Array.isArray(result.items)) return result.items.length;
  return Array.isArray(result) ? result.length : 0;
}

function elapsed(startedAt: number, endedAt: number): number {
  return nonnegative(endedAt - startedAt);
}

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}

function increment(value: number): number {
  return add(value, 1);
}

function add(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
