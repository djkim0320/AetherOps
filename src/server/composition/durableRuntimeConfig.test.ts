import { describe, expect, it } from "vitest";
import { resolveDurableRuntimeConfig, runtimeNow } from "./durableRuntimeConfig.js";

describe("durable runtime configuration", () => {
  it("creates a boot-unique worker identity rather than a PID-only owner", () => {
    const first = resolveDurableRuntimeConfig();
    const second = resolveDurableRuntimeConfig();
    expect(first.workerInstanceId).toMatch(new RegExp(`^server-${process.pid}-`));
    expect(second.workerInstanceId).not.toBe(first.workerInstanceId);
  });

  it("uses injected deterministic time and rejects an unsafe renewal interval", () => {
    const config = resolveDurableRuntimeConfig({ clock: { now: () => 1_700_000_000_000 }, leaseTtlMs: 1_000, leaseRenewalMs: 250 });
    expect(runtimeNow(config)).toBe("2023-11-14T22:13:20.000Z");
    expect(() => resolveDurableRuntimeConfig({ leaseTtlMs: 100, leaseRenewalMs: 100 })).toThrow(/smaller/);
  });
});
