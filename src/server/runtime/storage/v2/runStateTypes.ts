export interface StorageRunOwnership {
  projectId: string;
  runId: string;
  jobId: string;
}

export interface StorageTaskContractInput {
  id: string;
  projectId: string;
  schemaVersion: number;
  contentHash: string;
  createdAt: string;
  data: unknown;
}

export type StorageTaskContract = Readonly<StorageTaskContractInput>;

export interface StorageContextPackInput extends StorageRunOwnership {
  id: string;
  schemaVersion: number;
  stateRevision: number;
  taskContractId: string;
  taskContractHash: string;
  contentHash: string;
  recordedAt: string;
  data: unknown;
}

export type StorageContextPack = Readonly<StorageContextPackInput>;

export interface StorageRunStateRevisionInput extends StorageRunOwnership {
  id: string;
  schemaVersion: number;
  revision: number;
  previousRevision: number | null;
  parentRevisionHash: string | null;
  stateHash: string;
  taskContractId: string;
  taskContractHash: string;
  contextPackId?: string;
  recordedAt: string;
  data: unknown;
}

export type StorageRunStateRevision = Readonly<StorageRunStateRevisionInput>;

export interface StorageCommitRunStateRevisionInput {
  expectedRevision: number | null;
  revision: StorageRunStateRevisionInput;
}

export interface StorageSaveContextPackInput {
  expectedRevision: number;
  contextPack: StorageContextPackInput;
}
