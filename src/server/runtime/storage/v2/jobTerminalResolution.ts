import type { StorageJobStatus, StorageSettledJobStatus } from "./types.js";

export type CompletedStepDisposition = "committed" | "quarantined";

export interface DurableTerminalResolution {
  status: StorageSettledJobStatus;
  reason?: string;
  stepDisposition: CompletedStepDisposition;
}

export function resolveDurableTerminal(
  currentStatus: StorageJobStatus,
  requestedStatus: StorageSettledJobStatus,
  requestedReason: string | undefined,
  hasCompletedStep: boolean
): DurableTerminalResolution {
  if (currentStatus === "pause_requested") {
    return { status: "paused", reason: controlTerminalReason("paused"), stepDisposition: "quarantined" };
  }
  if (currentStatus === "cancel_requested") {
    return { status: "aborted", reason: controlTerminalReason("aborted"), stepDisposition: "quarantined" };
  }
  if (hasCompletedStep && requestedStatus === "completed" && (currentStatus === "paused" || currentStatus === "aborted")) {
    return { status: currentStatus, reason: controlTerminalReason(currentStatus), stepDisposition: "quarantined" };
  }
  return { status: requestedStatus, reason: requestedReason, stepDisposition: "committed" };
}

export function controlTerminalReason(status: "paused" | "aborted"): string {
  return status === "paused" ? "사용자 요청으로 작업을 일시정지했습니다." : "사용자 요청으로 작업을 중단했습니다.";
}
