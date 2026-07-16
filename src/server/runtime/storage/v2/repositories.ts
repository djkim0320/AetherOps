import type { DatabaseSync } from "node:sqlite";
import { ProjectRepository } from "./projectRepository.js";
import { RecordRepository } from "./recordRepository.js";
import { MemoryRepository } from "./memoryRepository.js";
import { EmbeddingRepository } from "./embeddingRepository.js";
import { JobRepository } from "./jobRepository.js";
import { EventRepository } from "./eventRepository.js";
import { CheckpointRepository } from "./checkpointRepository.js";
import { CapabilityAuditRepository } from "./capabilityRepository.js";
import { OntologyRepository } from "./ontologyRepository.js";
import { TraceRepository } from "./traceRepository.js";
import { RunStateRepository } from "./runStateRepository.js";
import { TerminalReceiptRepository } from "./terminalReceiptRepository.js";
import { TerminalResultReadbackRepository } from "./terminalResultReadbackRepository.js";
import { TerminalAttestationRepository } from "./terminalAttestationRepository.js";
import { TerminalAttestedReadbackRepository } from "./terminalAttestedReadbackRepository.js";
import { ToolSideEffectReservationRepository } from "./toolSideEffectReservationRepository.js";
import { EngineeringBaselineRepository } from "./engineeringBaselineRepository.js";
import { ProjectRevisionRepository } from "./projectRevisionRepository.js";
import { ProjectMutationRepository } from "./projectMutationRepository.js";
import { TerminalCasStore } from "./terminalCasStore.js";
import { createStorageTerminalCasReferenceSource } from "./terminalCasReferences.js";

export {
  ProjectRepository,
  RecordRepository,
  MemoryRepository,
  EmbeddingRepository,
  JobRepository,
  EventRepository,
  CheckpointRepository,
  CapabilityAuditRepository,
  OntologyRepository,
  TraceRepository,
  RunStateRepository,
  TerminalReceiptRepository,
  TerminalResultReadbackRepository,
  TerminalAttestationRepository,
  TerminalAttestedReadbackRepository,
  ToolSideEffectReservationRepository,
  EngineeringBaselineRepository,
  ProjectRevisionRepository,
  ProjectMutationRepository
};
export { runAtomically } from "./repositorySupport.js";

export interface StorageV2RepositorySet {
  projects: ProjectRepository;
  records: RecordRepository;
  memory: MemoryRepository;
  embeddings: EmbeddingRepository;
  jobs: JobRepository;
  checkpoints: CheckpointRepository;
  events: EventRepository;
  capabilities: CapabilityAuditRepository;
  ontology: OntologyRepository;
  trace: TraceRepository;
  runState: RunStateRepository;
  terminalReceipts: TerminalReceiptRepository;
  terminalReadback: TerminalResultReadbackRepository;
  terminalAttestations: TerminalAttestationRepository;
  terminalAttestedReadback: TerminalAttestedReadbackRepository;
  toolSideEffects: ToolSideEffectReservationRepository;
  engineering: EngineeringBaselineRepository;
  projectRevisions: ProjectRevisionRepository;
  projectMutations: ProjectMutationRepository;
}
export interface StorageV2RepositoryDbs {
  appDb: DatabaseSync;
  vectorDb?: DatabaseSync;
  ontologyDb?: DatabaseSync;
}

export interface StorageV2RepositoryOptions {
  leaseClock?: () => number;
  dataRoot?: string;
}

export function createStorageV2Repositories(dbs: StorageV2RepositoryDbs, options: StorageV2RepositoryOptions = {}): StorageV2RepositorySet {
  const vectorDb = dbs.vectorDb ?? dbs.appDb;
  const ontologyDb = dbs.ontologyDb ?? dbs.appDb;
  const embeddings = new EmbeddingRepository(vectorDb);
  const terminalReadback = new TerminalResultReadbackRepository(dbs.appDb, options.dataRoot);
  const terminalAttestations = new TerminalAttestationRepository(dbs.appDb, options.dataRoot, terminalReadback);
  const engineering = new EngineeringBaselineRepository(dbs.appDb, options.dataRoot);
  const projectRevisions = new ProjectRevisionRepository(dbs.appDb);
  const repositories: StorageV2RepositorySet = {
    projects: new ProjectRepository(dbs.appDb),
    records: new RecordRepository(vectorDb, embeddings),
    memory: new MemoryRepository(vectorDb, embeddings),
    embeddings,
    jobs: new JobRepository(dbs.appDb, options.leaseClock),
    checkpoints: new CheckpointRepository(dbs.appDb),
    events: new EventRepository(dbs.appDb, projectRevisions),
    capabilities: new CapabilityAuditRepository(dbs.appDb),
    ontology: new OntologyRepository(ontologyDb),
    trace: new TraceRepository(dbs.appDb),
    runState: new RunStateRepository(dbs.appDb),
    terminalReceipts: new TerminalReceiptRepository(dbs.appDb),
    terminalReadback,
    terminalAttestations,
    terminalAttestedReadback: new TerminalAttestedReadbackRepository(dbs.appDb, options.dataRoot, terminalAttestations),
    toolSideEffects: new ToolSideEffectReservationRepository(dbs.appDb),
    engineering,
    projectRevisions,
    projectMutations: new ProjectMutationRepository(dbs.appDb)
  };
  if (options.dataRoot) {
    new TerminalCasStore(options.dataRoot).reconcile(createStorageTerminalCasReferenceSource(dbs.appDb), 2_048);
  }
  return repositories;
}
