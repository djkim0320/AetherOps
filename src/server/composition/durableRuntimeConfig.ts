import { randomUUID } from "node:crypto";
import type { StorageWorkerClient } from "../runtime/storage/worker/typedRuntime.js";
import type { SseRuntimeDiagnostics } from "./sseRuntimeDiagnostics.js";

export interface DurableRuntimeClock {
  now(): number;
}

export interface DurableRuntimeTimer {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface DurableJobRuntimeOptions {
  concurrency?: number;
  leaseTtlMs?: number;
  leaseRenewalMs?: number;
  leaseSweepMs?: number;
  shutdownGraceMs?: number;
  workerInstanceId?: string;
  workerInstanceIdFactory?: () => string;
  clock?: DurableRuntimeClock;
  timer?: DurableRuntimeTimer;
  storageClient?: StorageWorkerClient;
  sseDiagnostics?: SseRuntimeDiagnostics;
}

export interface ResolvedDurableRuntimeConfig {
  concurrency: number;
  leaseTtlMs: number;
  leaseRenewalMs: number;
  leaseSweepMs: number;
  shutdownGraceMs: number;
  workerInstanceId: string;
  clock: DurableRuntimeClock;
  timer: DurableRuntimeTimer;
}

const systemClock: DurableRuntimeClock = { now: () => Date.now() };
const systemTimer: DurableRuntimeTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle)
};

export function resolveDurableRuntimeConfig(input: number | DurableJobRuntimeOptions = {}): ResolvedDurableRuntimeConfig {
  const options = typeof input === "number" ? { concurrency: input } : input;
  const leaseTtlMs = positiveInteger(options.leaseTtlMs, 60_000, "leaseTtlMs");
  const leaseRenewalMs = positiveInteger(options.leaseRenewalMs, 20_000, "leaseRenewalMs");
  if (leaseRenewalMs >= leaseTtlMs) throw new Error("leaseRenewalMs must be smaller than leaseTtlMs.");
  return {
    concurrency: boundedInteger(options.concurrency, 4, 1, 16, "concurrency"),
    leaseTtlMs,
    leaseRenewalMs,
    leaseSweepMs: positiveInteger(options.leaseSweepMs, 15_000, "leaseSweepMs"),
    shutdownGraceMs: nonnegativeInteger(options.shutdownGraceMs, 10_000, "shutdownGraceMs"),
    workerInstanceId: options.workerInstanceId ?? options.workerInstanceIdFactory?.() ?? `server-${process.pid}-${randomUUID()}`,
    clock: options.clock ?? systemClock,
    timer: options.timer ?? systemTimer
  };
}

export function runtimeNow(config: Pick<ResolvedDurableRuntimeConfig, "clock">): string {
  return new Date(config.clock.now()).toISOString();
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  return boundedInteger(value, fallback, 1, Number.MAX_SAFE_INTEGER, name);
}

function nonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  return boundedInteger(value, fallback, 0, Number.MAX_SAFE_INTEGER, name);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return resolved;
}
