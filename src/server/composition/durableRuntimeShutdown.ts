import type { DurableRuntimeTimer } from "./durableRuntimeConfig.js";

export async function waitForActiveRuns(runs: Iterable<Promise<unknown>>, timeoutMs: number, timer: DurableRuntimeTimer): Promise<boolean> {
  const pending = [...runs];
  if (!pending.length) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = timer.setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const settled = Promise.allSettled(pending).then(() => true as const);
  const result = await Promise.race([settled, expired]);
  if (timeout) timer.clearTimeout(timeout);
  return result;
}
