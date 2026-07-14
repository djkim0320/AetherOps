import { createHash } from "node:crypto";

export const BASELINE_SCHEMA_VERSION = 2 as const;
export const BENCHMARK_TOKENIZER_VERSION = "unicode-segments-v1" as const;

export type BaselineReceipt = Record<string, unknown> & {
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  id: string;
  type: string;
  receiptHash: string;
};

export class ReceiptCollector {
  private readonly rows: BaselineReceipt[] = [];
  private sequence = 0;

  add(type: string, fields: Record<string, unknown>): BaselineReceipt {
    this.sequence += 1;
    const body = {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      id: `receipt-${String(this.sequence).padStart(4, "0")}`,
      type,
      ...fields
    };
    const receipt = { ...body, receiptHash: hashCanonical(body) } satisfies BaselineReceipt;
    this.rows.push(receipt);
    return receipt;
  }

  all(): BaselineReceipt[] {
    return [...this.rows];
  }
}

export class LogicalClock {
  private currentMs = Date.parse("2026-07-14T00:00:00.000Z");
  private readonly RealDate = Date;

  install(): void {
    const now = () => this.currentMs;
    const RealDate = this.RealDate;
    class BaselineDate extends RealDate {
      constructor(value?: string | number) {
        super(value ?? now());
      }

      static now(): number {
        return now();
      }
    }
    globalThis.Date = BaselineDate as DateConstructor;
  }

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Logical clock increments must be non-negative integers.");
    this.currentMs += ms;
  }

  now(): number {
    return this.currentMs;
  }

  restore(): void {
    globalThis.Date = this.RealDate;
  }
}

export function countBenchmarkTokens(value: string): number {
  const segments = value.normalize("NFC").match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
  return segments?.length ?? 0;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)])
  );
}
