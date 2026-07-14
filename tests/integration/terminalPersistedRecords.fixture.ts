import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { storageCanonicalHasher } from "../../src/server/runtime/storage/v2/runStatePayloadValidator.js";
import { NOW, PROJECT_ID } from "./runStateStorageWorker.fixture.js";

export const ACCEPTANCE_DESCRIPTION = "Persisted evidence proves the terminal result.";

export function evidenceRecord() {
  return {
    id: "evidence-terminal-authority",
    projectId: PROJECT_ID,
    category: "evidence",
    title: "Persisted evidence",
    summary: "Verified deterministic evidence.",
    sourceId: "source-local",
    sourceUri: "aetherops://local/source",
    citation: "Local fixture",
    quote: "Deterministic evidence",
    doi: "10.0000/aetherops.fixture",
    keywords: ["deterministic", "terminal"],
    linkedHypothesisIds: ["hypothesis-terminal"],
    reliabilityScore: 1,
    relevanceScore: 1,
    evidenceStrength: "direct",
    limitations: [],
    createdAt: NOW
  };
}

export function validationRecord(id: string, supportingEvidenceIds: string[], projectId = PROJECT_ID) {
  return {
    id,
    projectId,
    iteration: 1,
    status: "supported",
    confidence: 1,
    supportingEvidenceIds,
    contradictingEvidenceIds: [],
    relatedEntityIds: [],
    relatedRelationIds: [],
    reasoningSummary: "Deterministic validation.",
    limitations: [],
    evidenceGaps: [],
    claimScorecard: {
      claimCount: 1,
      statusCounts: { supported: 1, missing_evidence: 0, contradicted: 0, attribution_unfaithful: 0, unknown: 0 },
      claims: [
        {
          id: `claim-${id}`,
          claim: ACCEPTANCE_DESCRIPTION,
          status: "supported",
          correctness: {
            status: "supported",
            confidence: 1,
            supportingEvidenceIds,
            contradictingEvidenceIds: [],
            rationale: "Persisted evidence is linked."
          },
          citationFaithfulness: {
            status: "faithful",
            citedEvidenceIds: supportingEvidenceIds,
            faithfulEvidenceIds: supportingEvidenceIds,
            unfaithfulEvidenceIds: [],
            rationale: "Persisted citation is linked."
          },
          evidenceGaps: []
        }
      ]
    },
    createdAt: NOW
  };
}

export function canonicalEvidenceHash(evidence: ReturnType<typeof evidenceRecord>): string {
  const { metadata: _metadata, ...payload } = { ...evidence, metadata: undefined };
  void _metadata;
  return storageCanonicalHasher.sha256Canonical(payload);
}

export function insertResearchRow(db: DatabaseSync, table: string, value: { id: string; projectId: string; createdAt: string }): void {
  db.prepare(`insert into ${table} (id,project_id,created_at,data) values (?,?,?,?)`).run(value.id, value.projectId, value.createdAt, JSON.stringify(value));
}

export function mutatePersistedValidation(storagePath: string, validationId: string): void {
  const db = new DatabaseSync(join(dirname(storagePath), "migration", "v2", "legacy-research.sqlite"));
  try {
    const row = db.prepare("select data from validation_results where id=?").get(validationId) as { data: string };
    const value = JSON.parse(row.data) as Record<string, unknown>;
    db.prepare("update validation_results set data=? where id=?").run(JSON.stringify({ ...value, confidence: 0.5 }), validationId);
  } finally {
    db.close();
  }
}

export function deletePersistedEvidence(storagePath: string, evidenceId: string): void {
  const db = new DatabaseSync(join(dirname(storagePath), "migration", "v2", "legacy-research.sqlite"));
  try {
    db.prepare("delete from evidence where id=?").run(evidenceId);
  } finally {
    db.close();
  }
}
