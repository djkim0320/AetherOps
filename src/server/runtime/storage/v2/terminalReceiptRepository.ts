import type { DatabaseSync } from "node:sqlite";
import { assertTerminalReceiptIntegrity } from "./terminalReceiptIntegrity.js";
import type { StorageCanonicalTerminalVerifierReceipt } from "./terminalReceiptTypes.js";

interface TerminalReceiptRow {
  id: unknown;
  project_id: unknown;
  run_id: unknown;
  job_id: unknown;
  request_hash: unknown;
  receipt_kind: unknown;
  criterion_id: unknown;
  subject_kind: unknown;
  subject_id: unknown;
  subject_hash: unknown;
  output_hash: unknown;
  source_receipt_ids: unknown;
  verifier_version: unknown;
  verified_at: unknown;
  receipt_hash: unknown;
}

export class TerminalReceiptRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(receipt: StorageCanonicalTerminalVerifierReceipt): StorageCanonicalTerminalVerifierReceipt {
    assertTerminalReceiptIntegrity(receipt);
    this.db
      .prepare(
        `insert into canonical_terminal_verifier_receipts
        (id,project_id,run_id,job_id,request_hash,receipt_kind,criterion_id,subject_kind,subject_id,subject_hash,
         output_hash,source_receipt_ids,verifier_version,verified_at,receipt_hash)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        receipt.id,
        receipt.projectId,
        receipt.runId,
        receipt.jobId,
        receipt.requestHash,
        receipt.receiptKind,
        receipt.criterionId,
        receipt.subjectKind,
        receipt.subjectId,
        receipt.subjectHash,
        receipt.outputHash,
        JSON.stringify(receipt.sourceReceiptIds),
        receipt.verifierVersion,
        receipt.verifiedAt,
        receipt.receiptHash
      );
    return this.required(receipt.id);
  }

  get(id: string): StorageCanonicalTerminalVerifierReceipt | undefined {
    const row = this.db.prepare("select * from canonical_terminal_verifier_receipts where id=?").get(id) as TerminalReceiptRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByRequest(jobId: string, requestHash: string): StorageCanonicalTerminalVerifierReceipt[] {
    return (
      this.db
        .prepare(
          "select * from canonical_terminal_verifier_receipts where job_id=? and request_hash=? order by receipt_kind,criterion_id,subject_kind,subject_id,id"
        )
        .all(jobId, requestHash) as unknown as TerminalReceiptRow[]
    ).map(mapRow);
  }

  listByJob(jobId: string): StorageCanonicalTerminalVerifierReceipt[] {
    return (this.db.prepare("select * from canonical_terminal_verifier_receipts where job_id=? order by id").all(jobId) as unknown as TerminalReceiptRow[]).map(
      mapRow
    );
  }

  listByIds(ids: readonly string[]): StorageCanonicalTerminalVerifierReceipt[] {
    if (!ids.length) return [];
    if (ids.length > 256) throw new Error("Canonical terminal verifier receipt readback exceeds the bounded limit.");
    const placeholders = ids.map(() => "?").join(",");
    return (
      this.db
        .prepare(`select * from canonical_terminal_verifier_receipts where id in (${placeholders}) order by id`)
        .all(...ids) as unknown as TerminalReceiptRow[]
    ).map(mapRow);
  }

  private required(id: string): StorageCanonicalTerminalVerifierReceipt {
    const value = this.get(id);
    if (!value) throw new Error(`Canonical terminal verifier receipt readback is missing: ${id}`);
    return value;
  }
}

function mapRow(row: TerminalReceiptRow): StorageCanonicalTerminalVerifierReceipt {
  const receipt = {
    id: String(row.id),
    projectId: String(row.project_id),
    runId: String(row.run_id),
    jobId: String(row.job_id),
    requestHash: String(row.request_hash),
    receiptKind: String(row.receipt_kind) as StorageCanonicalTerminalVerifierReceipt["receiptKind"],
    criterionId: String(row.criterion_id),
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    subjectHash: String(row.subject_hash),
    outputHash: String(row.output_hash),
    sourceReceiptIds: parseStringArray(row.source_receipt_ids),
    verifierVersion: String(row.verifier_version) as StorageCanonicalTerminalVerifierReceipt["verifierVersion"],
    verifiedAt: String(row.verified_at),
    receiptHash: String(row.receipt_hash)
  };
  assertTerminalReceiptIntegrity(receipt);
  return receipt;
}

function parseStringArray(value: unknown): string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Canonical terminal verifier source receipt readback is malformed.");
  }
  return parsed;
}
