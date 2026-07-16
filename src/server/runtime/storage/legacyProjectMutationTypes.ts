import type { ResearchProject, ResearchSession, ResearchSnapshot } from "../../../core/shared/types.js";

export type LegacyProjectMutationMethod = "project.create" | "project.update" | "session.create" | "session.delete";

export type LegacyProjectMutationCommand = { project: ResearchProject } | { session: ResearchSession } | { sessionId: string };

export interface LegacyProjectMutationRequest {
  operationId: string;
  method: LegacyProjectMutationMethod;
  requestHash: string;
  projectId: string;
  expectedBeforeHash: string | null;
  command: LegacyProjectMutationCommand;
  appliedAt: string;
}

export type LegacyProjectMutationResultIdentity =
  { kind: "project"; projectId: string } | { kind: "session"; projectId: string; sessionId: string; state: "created" | "deleted" };

export interface LegacyProjectMutationReceipt {
  operationId: string;
  method: LegacyProjectMutationMethod;
  requestHash: string;
  commandHash: string;
  projectId: string;
  beforeHash: string | null;
  snapshotHash: string;
  resultJson: string;
  resultHash: string;
  appliedAt: string;
  receiptHash: string;
}

export interface LegacyProjectMutationApplyResult {
  snapshot: ResearchSnapshot;
  receipt: LegacyProjectMutationReceipt;
  exactReplay: boolean;
}

export interface LegacyProjectMutationReceiptQuery {
  projectId?: string;
  limit?: number;
}

export interface LegacyProjectMutationPort {
  apply(request: LegacyProjectMutationRequest): Promise<LegacyProjectMutationApplyResult>;
  getReceipt(operationId: string): Promise<LegacyProjectMutationReceipt | undefined>;
  listReceipts(query?: LegacyProjectMutationReceiptQuery): Promise<LegacyProjectMutationReceipt[]>;
}
