import { describe, expect, it } from "vitest";
import { DurableRuntimeDiagnostics } from "./durableRuntimeDiagnostics.js";

describe("durable runtime diagnostics", () => {
  it("keeps bounded aggregate counters without retaining identifiers", () => {
    const diagnostics = new DurableRuntimeDiagnostics();
    diagnostics.setActiveProjects(2);
    diagnostics.setActiveJobs(3);
    diagnostics.recordRenewal(true);
    diagnostics.recordRenewal(false);
    diagnostics.recordLeaseLost();
    diagnostics.recordStaleWriteRejection();
    diagnostics.recordRecoveryProjects(1_001);
    expect(diagnostics.snapshot()).toEqual({
      activeProjectCount: 2,
      activeJobCount: 3,
      leaseRenewalSuccessCount: 1,
      leaseRenewalFailureCount: 1,
      leaseLostCount: 1,
      staleWriteRejectionCount: 1,
      recoveryScannedProjectCount: 1_001
    });
  });
});
