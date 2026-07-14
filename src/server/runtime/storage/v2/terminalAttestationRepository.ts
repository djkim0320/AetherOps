import type { DatabaseSync } from "node:sqlite";
import { storageCanonicalHasher } from "./runStatePayloadValidator.js";
import { TerminalCasStore } from "./terminalCasStore.js";
import type { StorageTerminalResultAttestation, StorageTerminalAttestationBatch } from "./terminalAttestationTypes.js";
import type { StorageTerminalCriterionCandidate, StorageTerminalResourceCandidate } from "./terminalReceiptTypes.js";
import type { StorageRunOwnership } from "./runStateTypes.js";
import type { StorageTerminalResultReadback, StorageTerminalResultReadbackRequest } from "./terminalResultReadbackRepository.js";
import { TerminalResultReadbackRepository } from "./terminalResultReadbackRepository.js";

const MAX_ATTESTATIONS = 512;

interface AttestationRow {
  [key: string]: unknown;
}

export interface StorageTerminalAttestationResolveInput {
  owner: StorageRunOwnership;
  resources: StorageTerminalResourceCandidate[];
  criteria: StorageTerminalCriterionCandidate[];
  attestedAt: string;
}

export interface StorageTerminalAttestationResolution extends StorageTerminalAttestationBatch {
  artifacts: Map<string, StorageTerminalResultAttestation>;
  evidence: Map<string, StorageTerminalResultAttestation>;
  validations: Map<string, StorageTerminalResultAttestation>;
}

export class TerminalAttestationRepository {
  private readonly cas: TerminalCasStore;

  constructor(
    private readonly db: DatabaseSync,
    dataRoot: string | undefined,
    private readonly source: TerminalResultReadbackRepository
  ) {
    this.cas = new TerminalCasStore(dataRoot);
    if (dataRoot) this.cas.cleanup(this.referencedLocators(), 2_048);
  }

  resolveOrCreate(input: StorageTerminalAttestationResolveInput): StorageTerminalAttestationResolution {
    const expected = expectedSubjects(input);
    const existing = this.listByJob(input.owner.jobId);
    if (existing.length) return this.assertExact(input, expected, existing, true);
    const readback = this.source.read(readbackRequest(input));
    const created = buildAttestations(input, expected, readback);
    for (const attestation of [...created].sort(
      (left, right) => Number(right.subjectKind === "validation_result") - Number(left.subjectKind === "validation_result")
    )) {
      this.save(attestation);
    }
    return this.assertExact(input, expected, this.listByJob(input.owner.jobId), false);
  }

  listByJob(jobId: string): StorageTerminalResultAttestation[] {
    const count = Number(
      (this.db.prepare("select count(*) count from canonical_terminal_result_attestations where job_id=?").get(jobId) as { count: unknown }).count
    );
    if (!Number.isSafeInteger(count) || count > MAX_ATTESTATIONS) {
      throw new Error("Canonical terminal attestation readback exceeds its bounded limit.");
    }
    const rows = this.db
      .prepare("select * from canonical_terminal_result_attestations where job_id=? order by subject_kind,subject_id,id limit ?")
      .all(jobId, MAX_ATTESTATIONS + 1) as AttestationRow[];
    if (rows.length > MAX_ATTESTATIONS) throw new Error("Canonical terminal attestation readback exceeds its bounded limit.");
    return rows.map(mapRow);
  }

  listByIds(ids: readonly string[]): StorageTerminalResultAttestation[] {
    if (!ids.length) return [];
    if (ids.length > MAX_ATTESTATIONS || new Set(ids).size !== ids.length)
      throw new Error("Canonical terminal attestation readback is unbounded or duplicated.");
    const placeholders = ids.map(() => "?").join(",");
    return (
      this.db.prepare(`select * from canonical_terminal_result_attestations where id in (${placeholders}) order by id`).all(...ids) as AttestationRow[]
    ).map(mapRow);
  }

  assertCas(attestations: readonly StorageTerminalResultAttestation[]): void {
    if (attestations.length) {
      const batches = new Set(attestations.map((value) => value.batchHash));
      const calculated = storageCanonicalHasher.sha256Canonical(attestations.map((value) => value.attestationHash).sort());
      if (batches.size !== 1 || attestations[0]?.batchHash !== calculated) {
        throw new Error("Canonical terminal attestation batch hash is invalid.");
      }
    }
    for (const attestation of attestations) {
      assertAttestationIntegrity(attestation);
      this.cas.verify(attestation);
    }
  }

  finalize(attestations: readonly StorageTerminalResultAttestation[]): void {
    this.cas.finalize(attestations);
  }

  private save(value: StorageTerminalResultAttestation): void {
    assertAttestationIntegrity(value);
    this.cas.verify(value);
    this.db
      .prepare(
        `insert into canonical_terminal_result_attestations
        (id,schema_version,project_id,run_id,job_id,batch_hash,subject_kind,subject_id,content_hash,cas_locator,cas_hash,byte_length,
         attempt_id,output_link_id,validation_attestation_id,provenance_attestation_ids,supporting_evidence_ids,contradicting_evidence_ids,
         source_evidence_ids_hash,supported_claim_hashes,attested_at,attestation_hash)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        value.id,
        value.schemaVersion,
        value.projectId,
        value.runId,
        value.jobId,
        value.batchHash,
        value.subjectKind,
        value.subjectId,
        value.contentHash,
        value.casLocator,
        value.casHash,
        value.byteLength,
        value.attemptId ?? null,
        value.outputLinkId ?? null,
        value.validationAttestationId ?? null,
        JSON.stringify(value.provenanceAttestationIds),
        JSON.stringify(value.supportingEvidenceIds),
        JSON.stringify(value.contradictingEvidenceIds),
        value.sourceEvidenceIdsHash,
        JSON.stringify(value.supportedClaimHashes),
        value.attestedAt,
        value.attestationHash
      );
  }

  private assertExact(
    input: StorageTerminalAttestationResolveInput,
    expected: ReturnType<typeof expectedSubjects>,
    values: StorageTerminalResultAttestation[],
    exactReplay: boolean
  ): StorageTerminalAttestationResolution {
    if (values.length !== expected.resources.length + expected.validations.size) {
      throw new Error("Canonical terminal attestation replay is incomplete or contains an unexpected subject.");
    }
    if (!values.length) {
      return {
        batchHash: storageCanonicalHasher.sha256Canonical([]),
        attestations: [],
        exactReplay,
        artifacts: new Map(),
        evidence: new Map(),
        validations: new Map()
      };
    }
    const bySubject = new Map(values.map((value) => [`${value.subjectKind}\u0000${value.subjectId}`, value]));
    const validations = new Map<string, StorageTerminalResultAttestation>();
    for (const [id, hash] of expected.validations) {
      const value = bySubject.get(`validation_result\u0000${id}`);
      if (!value || (!exactReplay && value.contentHash !== hash)) throw new Error(`Canonical terminal validation attestation changed: ${id}`);
      validations.set(id, value);
    }
    const artifacts = new Map<string, StorageTerminalResultAttestation>();
    const evidence = new Map<string, StorageTerminalResultAttestation>();
    for (const candidate of expected.resources) {
      const value = bySubject.get(`${candidate.outputKind}\u0000${candidate.outputId}`);
      const validation = candidate.validationResultId ? validations.get(candidate.validationResultId) : undefined;
      if (
        !value ||
        (!exactReplay && value.contentHash !== candidate.contentHash) ||
        value.attemptId !== candidate.attemptId ||
        value.outputLinkId !== candidate.outputLinkId ||
        value.validationAttestationId !== validation?.id
      ) {
        throw new Error(`Canonical terminal resource attestation changed: ${candidate.outputId}`);
      }
      (candidate.outputKind === "artifact" ? artifacts : evidence).set(candidate.outputId, value);
    }
    for (const validation of validations.values()) {
      const expectedProvenance = [...validation.supportingEvidenceIds, ...validation.contradictingEvidenceIds]
        .map((evidenceId) => evidence.get(evidenceId)?.id)
        .filter((id): id is string => Boolean(id))
        .sort();
      if (
        expectedProvenance.length !== validation.supportingEvidenceIds.length + validation.contradictingEvidenceIds.length ||
        !sameStrings(expectedProvenance, validation.provenanceAttestationIds) ||
        !validation.supportedClaimHashes.length
      ) {
        throw new Error(`Canonical terminal validation attestation provenance changed: ${validation.subjectId}`);
      }
    }
    const batches = new Set(values.map((value) => value.batchHash));
    const calculatedBatchHash = storageCanonicalHasher.sha256Canonical(values.map((value) => value.attestationHash).sort());
    if (batches.size !== 1) throw new Error("Canonical terminal attestations cross an immutable batch boundary.");
    if (values[0]?.batchHash !== calculatedBatchHash) throw new Error("Canonical terminal attestation batch hash is invalid.");
    if (values.some((value) => value.projectId !== input.owner.projectId || value.runId !== input.owner.runId || value.jobId !== input.owner.jobId)) {
      throw new Error("Canonical terminal attestations cross an immutable owner boundary.");
    }
    this.assertCas(values);
    return { batchHash: values[0]!.batchHash, attestations: [...values].sort(compareAttestations), exactReplay, artifacts, evidence, validations };
  }

  private referencedLocators(): Set<string> {
    const rows = this.db.prepare("select cas_locator from canonical_terminal_result_attestations").all() as Array<{ cas_locator?: unknown }>;
    return new Set(rows.map((row) => String(row.cas_locator)));
  }
}

function buildAttestations(
  input: StorageTerminalAttestationResolveInput,
  expected: ReturnType<typeof expectedSubjects>,
  readback: StorageTerminalResultReadback
): StorageTerminalResultAttestation[] {
  const resourceDrafts = expected.resources.map((candidate) => {
    const source = candidate.outputKind === "artifact" ? readback.artifacts.get(candidate.outputId) : readback.evidence.get(candidate.outputId);
    if (!source || source.contentHash !== candidate.contentHash) throw new Error(`Canonical terminal source changed before attestation: ${candidate.outputId}`);
    return draft(input, candidate.outputKind, source, {
      attemptId: candidate.attemptId,
      outputLinkId: candidate.outputLinkId
    });
  });
  const resourceIds = new Map(resourceDrafts.map((value) => [value.subjectId, value.id]));
  const validationDrafts = [...expected.validations].map(([id, hash]) => {
    const source = readback.validations.get(id);
    if (!source || source.contentHash !== hash) throw new Error(`Canonical terminal validation changed before attestation: ${id}`);
    const provenanceIds = [...source.supportingEvidenceIds, ...source.contradictingEvidenceIds].map((evidenceId) => {
      const attestationId = resourceIds.get(evidenceId);
      if (!attestationId) throw new Error(`Canonical terminal validation provenance is not promoted: ${evidenceId}`);
      return attestationId;
    });
    return draft(input, "validation_result", source, {
      provenanceAttestationIds: [...new Set(provenanceIds)].sort(),
      supportingEvidenceIds: source.supportingEvidenceIds,
      contradictingEvidenceIds: source.contradictingEvidenceIds,
      supportedClaimHashes: source.supportedClaimHashes
    });
  });
  const validationIds = new Map(validationDrafts.map((value) => [value.subjectId, value.id]));
  const drafts = [
    ...validationDrafts,
    ...resourceDrafts.map((value, index) => ({
      ...value,
      ...(expected.resources[index]?.validationResultId ? { validationAttestationId: validationIds.get(expected.resources[index]!.validationResultId!) } : {})
    }))
  ];
  const hashed = drafts.map((value) => ({ ...value, attestationHash: attestationHash(value) }));
  const batchHash = storageCanonicalHasher.sha256Canonical(hashed.map((value) => value.attestationHash).sort());
  return hashed.map((value) => ({ ...value, batchHash })).sort(compareAttestations);
}

function draft(
  input: StorageTerminalAttestationResolveInput,
  subjectKind: StorageTerminalResultAttestation["subjectKind"],
  source: { id: string; contentHash: string; casLocator: string; casHash: string; byteLength: number },
  metadata: Partial<StorageTerminalResultAttestation>
): Omit<StorageTerminalResultAttestation, "batchHash" | "attestationHash"> {
  const identity = {
    owner: input.owner,
    subjectKind,
    subjectId: source.id,
    contentHash: source.contentHash,
    attemptId: metadata.attemptId ?? null,
    outputLinkId: metadata.outputLinkId ?? null
  };
  const supportingEvidenceIds = [...(metadata.supportingEvidenceIds ?? [])].sort();
  const contradictingEvidenceIds = [...(metadata.contradictingEvidenceIds ?? [])].sort();
  return {
    id: `terminal_attestation_${storageCanonicalHasher.sha256Canonical(identity)}`,
    schemaVersion: 1,
    ...input.owner,
    subjectKind,
    subjectId: source.id,
    contentHash: source.contentHash,
    casLocator: source.casLocator,
    casHash: source.casHash,
    byteLength: source.byteLength,
    ...(metadata.attemptId ? { attemptId: metadata.attemptId } : {}),
    ...(metadata.outputLinkId ? { outputLinkId: metadata.outputLinkId } : {}),
    ...(metadata.validationAttestationId ? { validationAttestationId: metadata.validationAttestationId } : {}),
    provenanceAttestationIds: [...(metadata.provenanceAttestationIds ?? [])].sort(),
    supportingEvidenceIds,
    contradictingEvidenceIds,
    sourceEvidenceIdsHash: storageCanonicalHasher.sha256Canonical({ supportingEvidenceIds, contradictingEvidenceIds }),
    supportedClaimHashes: [...(metadata.supportedClaimHashes ?? [])].sort(),
    attestedAt: input.attestedAt
  };
}

function attestationHash(value: Omit<StorageTerminalResultAttestation, "batchHash" | "attestationHash">): string {
  return storageCanonicalHasher.sha256Canonical(value);
}

export function assertAttestationIntegrity(value: StorageTerminalResultAttestation): void {
  const { batchHash, attestationHash: storedHash, ...payload } = value;
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(batchHash) || attestationHash(payload) !== storedHash) {
    throw new Error("Canonical terminal attestation integrity check failed.");
  }
  if (value.casHash !== value.contentHash || value.byteLength < 0 || !Number.isSafeInteger(value.byteLength)) {
    throw new Error("Canonical terminal attestation CAS metadata is inconsistent.");
  }
  if (
    value.sourceEvidenceIdsHash !==
    storageCanonicalHasher.sha256Canonical({
      supportingEvidenceIds: [...value.supportingEvidenceIds].sort(),
      contradictingEvidenceIds: [...value.contradictingEvidenceIds].sort()
    })
  ) {
    throw new Error("Canonical terminal attestation provenance hash is inconsistent.");
  }
  for (const list of [value.provenanceAttestationIds, value.supportingEvidenceIds, value.contradictingEvidenceIds, value.supportedClaimHashes]) {
    if (list.length > MAX_ATTESTATIONS || new Set(list).size !== list.length) throw new Error("Canonical terminal attestation provenance is malformed.");
  }
}

function expectedSubjects(input: StorageTerminalAttestationResolveInput): {
  resources: StorageTerminalResourceCandidate[];
  validations: Map<string, string>;
} {
  const resources = [...input.resources].sort((left, right) => `${left.outputKind}:${left.outputId}`.localeCompare(`${right.outputKind}:${right.outputId}`));
  const validations = new Map<string, string>();
  const add = (id: string | undefined, hash: string | undefined): void => {
    if (!id || !hash) return;
    const existing = validations.get(id);
    if (existing && existing !== hash) throw new Error(`Canonical terminal validation candidate hashes disagree: ${id}`);
    validations.set(id, hash);
  };
  for (const resource of resources) add(resource.validationResultId, resource.validationResultHash);
  for (const criterion of input.criteria) if (criterion.verificationKind === "validation") add(criterion.validationResultId, criterion.validationResultHash);
  if (resources.length + validations.size > MAX_ATTESTATIONS) throw new Error("Canonical terminal attestation request exceeds the bounded limit.");
  return { resources, validations: new Map([...validations].sort(([left], [right]) => left.localeCompare(right))) };
}

function readbackRequest(input: StorageTerminalAttestationResolveInput): StorageTerminalResultReadbackRequest {
  const expected = expectedSubjects(input);
  return {
    projectId: input.owner.projectId,
    artifactIds: expected.resources.filter((value) => value.outputKind === "artifact").map((value) => value.outputId),
    evidenceIds: expected.resources.filter((value) => value.outputKind === "evidence").map((value) => value.outputId),
    validationResultIds: [...expected.validations.keys()]
  };
}

function mapRow(row: AttestationRow): StorageTerminalResultAttestation {
  const value: StorageTerminalResultAttestation = {
    id: String(row.id),
    schemaVersion: Number(row.schema_version) as 1,
    projectId: String(row.project_id),
    runId: String(row.run_id),
    jobId: String(row.job_id),
    batchHash: String(row.batch_hash),
    subjectKind: String(row.subject_kind) as StorageTerminalResultAttestation["subjectKind"],
    subjectId: String(row.subject_id),
    contentHash: String(row.content_hash),
    casLocator: String(row.cas_locator),
    casHash: String(row.cas_hash),
    byteLength: Number(row.byte_length),
    ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}),
    ...(row.output_link_id ? { outputLinkId: String(row.output_link_id) } : {}),
    ...(row.validation_attestation_id ? { validationAttestationId: String(row.validation_attestation_id) } : {}),
    provenanceAttestationIds: parseArray(row.provenance_attestation_ids),
    supportingEvidenceIds: parseArray(row.supporting_evidence_ids),
    contradictingEvidenceIds: parseArray(row.contradicting_evidence_ids),
    sourceEvidenceIdsHash: String(row.source_evidence_ids_hash),
    supportedClaimHashes: parseArray(row.supported_claim_hashes),
    attestedAt: String(row.attested_at),
    attestationHash: String(row.attestation_hash)
  };
  assertAttestationIntegrity(value);
  return value;
}

function parseArray(value: unknown): string[] {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1024 * 1024) throw new Error("Canonical terminal attestation JSON is malformed.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Canonical terminal attestation JSON is malformed.");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error("Canonical terminal attestation JSON is malformed.");
  }
  return parsed;
}

function compareAttestations(left: StorageTerminalResultAttestation, right: StorageTerminalResultAttestation): number {
  return left.subjectKind.localeCompare(right.subjectKind) || left.subjectId.localeCompare(right.subjectId) || left.id.localeCompare(right.id);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
