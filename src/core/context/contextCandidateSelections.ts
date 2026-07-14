import { ContextCompilerError, type ContextCompilerInput } from "./contextTypes.js";

const STABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;

export function validateContextCandidateSelections(input: ContextCompilerInput): void {
  validateSelection(
    input.candidateSelections.memory,
    input.memories.map((item) => item.id),
    "snapshot.global_memory_items"
  );
  validateSelection(
    input.candidateSelections.priorOutputs,
    input.priorOutputs.map((item) => item.id),
    "snapshot.conversation_artifacts"
  );
}

function validateSelection(
  receipt: ContextCompilerInput["candidateSelections"]["memory"],
  actualIds: string[],
  expectedSource: ContextCompilerInput["candidateSelections"]["memory"]["source"]
): void {
  if (receipt.source !== expectedSource) invalid(`Context candidate selection source mismatch: ${expectedSource}`);
  const selectedIds = validatedIds(receipt.selectedIds, expectedSource);
  const normalizedActual = validatedIds(actualIds, expectedSource);
  if (selectedIds.length !== normalizedActual.length || selectedIds.some((id, index) => id !== normalizedActual[index])) {
    invalid(`Context candidate selection receipt does not match selected inputs: ${expectedSource}`);
  }
  if (!Number.isSafeInteger(receipt.candidateCount) || !Number.isSafeInteger(receipt.omittedCount) || receipt.candidateCount < 0 || receipt.omittedCount < 0) {
    invalid(`Context candidate selection counts must be nonnegative integers: ${expectedSource}`);
  }
  if (receipt.candidateCount !== selectedIds.length + receipt.omittedCount) invalid(`Context candidate selection count mismatch: ${expectedSource}`);
  if (receipt.status === "empty" && (selectedIds.length !== 0 || !receipt.emptyReason))
    invalid(`Empty context selection requires an explicit reason: ${expectedSource}`);
  if (receipt.status === "selected" && (selectedIds.length === 0 || receipt.emptyReason))
    invalid(`Selected context receipt has an invalid empty reason: ${expectedSource}`);
}

function validatedIds(values: string[], source: string): string[] {
  if (new Set(values).size !== values.length || values.some((value) => !STABLE_ID.test(value)))
    invalid(`Context candidate selection contains invalid or duplicate IDs: ${source}`);
  return [...values].sort();
}

function invalid(message: string): never {
  throw new ContextCompilerError("INVALID_CONTEXT_INPUT", message);
}
