import { describe, expect, it, vi } from "vitest";
import { CapabilityMutationGate } from "./capabilityMutationGate.js";

describe("CapabilityMutationGate", () => {
  it("keeps a settings revocation behind an in-flight capability-sensitive commit", async () => {
    const gate = new CapabilityMutationGate();
    let releaseCommit = (): void => undefined;
    const commitPending = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const activationEntered = vi.fn();
    const revocationEntered = vi.fn();
    const activation = gate.runExclusive(async () => {
      activationEntered();
      await commitPending;
      return "activated";
    });
    await Promise.resolve();
    const revocation = gate.runExclusive(async () => {
      revocationEntered();
      return "revoked";
    });

    expect(activationEntered).toHaveBeenCalledOnce();
    expect(revocationEntered).not.toHaveBeenCalled();
    releaseCommit();
    await expect(activation).resolves.toBe("activated");
    await expect(revocation).resolves.toBe("revoked");
    expect(revocationEntered).toHaveBeenCalledOnce();
  });
});
