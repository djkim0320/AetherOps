import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";

interface DurableLeaseRenewalOptions {
  intervalMs: number;
  timer: DurableRuntimeTimer;
  renew(): Promise<void>;
  onFailure(error: unknown): void | Promise<void>;
}

export interface DurableLeaseRenewal {
  stop(): Promise<void>;
}

/** Runs one renewal at a time and makes every rejection observable. */
export function startDurableLeaseRenewal(options: DurableLeaseRenewalOptions): DurableLeaseRenewal {
  let running = true;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let observerFailure: unknown;
  let stopPromise: Promise<void> | undefined;

  const schedule = (): void => {
    if (!running) return;
    handle = options.timer.setTimeout(run, options.intervalMs);
    handle.unref?.();
  };
  const run = (): void => {
    handle = undefined;
    if (!running) return;
    const operation = Promise.resolve()
      .then(() => options.renew())
      .catch(async (error) => {
        running = false;
        try {
          await options.onFailure(error);
        } catch (failure) {
          observerFailure = failure;
        }
      })
      .finally(() => {
        inFlight = undefined;
        schedule();
      });
    inFlight = operation;
  };
  schedule();

  const stop = async (): Promise<void> => {
    running = false;
    if (handle) {
      options.timer.clearTimeout(handle);
      handle = undefined;
    }
    await inFlight;
    if (observerFailure !== undefined) throw observerFailure;
  };

  return {
    stop: () => (stopPromise ??= stop())
  };
}
