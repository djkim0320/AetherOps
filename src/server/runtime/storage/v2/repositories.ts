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
  TraceRepository
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
}
export interface StorageV2RepositoryDbs {
  appDb: DatabaseSync;
  vectorDb?: DatabaseSync;
  ontologyDb?: DatabaseSync;
}
export function createStorageV2Repositories(dbs: StorageV2RepositoryDbs): StorageV2RepositorySet {
  const vectorDb = dbs.vectorDb ?? dbs.appDb;
  const ontologyDb = dbs.ontologyDb ?? dbs.appDb;
  const embeddings = new EmbeddingRepository(vectorDb);
  return {
    projects: new ProjectRepository(dbs.appDb),
    records: new RecordRepository(vectorDb, embeddings),
    memory: new MemoryRepository(vectorDb, embeddings),
    embeddings,
    jobs: new JobRepository(dbs.appDb),
    checkpoints: new CheckpointRepository(dbs.appDb),
    events: new EventRepository(dbs.appDb),
    capabilities: new CapabilityAuditRepository(dbs.appDb),
    ontology: new OntologyRepository(ontologyDb),
    trace: new TraceRepository(dbs.appDb)
  };
}
