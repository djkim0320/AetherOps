import { assertToolAttemptOutputPromotionAllowed } from "./toolPostcondition.js";
import { assertHash, assertUnique } from "./terminalReceiptIntegrity.js";
import type { StorageTerminalResourceCandidate } from "./terminalReceiptTypes.js";
import type { StorageV2RepositorySet } from "./repositories.js";
import type { StorageJob } from "./types.js";
import type { StorageToolAttempt } from "./traceTypes.js";
import { readCompleteTerminalOutputLinks } from "./terminalBoundedReadback.js";

export function assertTerminalResourceOrigins(
  repositories: StorageV2RepositorySet,
  job: StorageJob,
  attempts: StorageToolAttempt[],
  candidates: StorageTerminalResourceCandidate[]
): void {
  assertUnique(
    candidates.map((candidate) => candidate.outputLinkId),
    "terminal resource output link"
  );
  assertUnique(
    candidates.map((candidate) => `${candidate.outputKind}\u0000${candidate.outputId}`),
    "terminal resource"
  );
  const completed = new Map(attempts.filter((attempt) => attempt.status === "completed").map((attempt) => [attempt.id, attempt]));
  const links = readCompleteTerminalOutputLinks(repositories, [...completed.keys()], "verifier")
    .filter((link) => link.outputKind !== "source")
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const candidate of candidates) {
    assertHash(candidate.contentHash, "terminal resource content");
    if (candidate.validationResultHash) assertHash(candidate.validationResultHash, "terminal validation result");
    const attempt = completed.get(candidate.attemptId);
    const link = links.find((entry) => entry.id === candidate.outputLinkId);
    if (!attempt || !attempt.outputHash || !link || link.promoted) {
      throw new Error(`Canonical terminal resource lacks an unpromoted persisted origin: ${candidate.outputId}`);
    }
    assertHash(attempt.outputHash, "terminal attempt output");
    if (
      link.jobId !== job.id ||
      link.projectId !== job.projectId ||
      link.attemptId !== attempt.id ||
      link.outputKind !== candidate.outputKind ||
      link.outputId !== candidate.outputId
    ) {
      throw new Error(`Canonical terminal resource origin linkage is invalid: ${candidate.outputId}`);
    }
    assertToolAttemptOutputPromotionAllowed(attempt);
    if (candidate.outputKind === "evidence" && (!candidate.validationResultId || !candidate.validationResultHash)) {
      throw new Error(`Canonical evidence ${candidate.outputId} requires a hash-bound validation result.`);
    }
  }
  if (links.length !== candidates.length || links.some((link) => !candidates.some((candidate) => candidate.outputLinkId === link.id))) {
    throw new Error("Canonical terminal verifier resource candidates do not cover every promotable persisted output.");
  }
}
