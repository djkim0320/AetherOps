import type { StoragePostCommitReconciliationWarning } from "../runtime/storage/v2/jobAtomicTypes.js";
import { logDurablePostCommitWarning } from "./durableRuntimeFailureLogger.js";

export function handleDurablePostCommitWarning(
  warning: StoragePostCommitReconciliationWarning,
  context: { jobId: string; projectId: string },
  enterFailClosedDrain: () => void
): void {
  logDurablePostCommitWarning(warning, context);
  if (warning.severity === "error") enterFailClosedDrain();
}
