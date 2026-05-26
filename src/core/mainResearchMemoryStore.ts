import type {
  GlobalMemoryItem,
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  ResearchArtifact,
  ResearchChunk,
  ResearchSource,
  ToolRun
} from "./types.js";

export interface MainResearchMemoryStore {
  saveGlobalSources(sources: ResearchSource[]): Promise<void>;
  saveGlobalArtifacts(artifacts: ResearchArtifact[]): Promise<void>;
  saveGlobalNormalizedRecords(records: NormalizedResearchRecord[]): Promise<void>;
  saveGlobalChunks(chunks: ResearchChunk[]): Promise<void>;
  saveGlobalOntologyEntities(entities: OntologyEntity[]): Promise<void>;
  saveGlobalOntologyRelations(relations: OntologyRelation[]): Promise<void>;
  saveGlobalOntologyConstraints(constraints: OntologyConstraint[]): Promise<void>;
  saveGlobalToolRuns(toolRuns: ToolRun[]): Promise<void>;
  saveGlobalMemoryItems(items: GlobalMemoryItem[]): Promise<void>;
  searchGlobalRecords(query: string, options?: MainMemorySearchOptions): Promise<NormalizedResearchRecord[]>;
  searchGlobalChunks(query: string, options?: MainMemorySearchOptions): Promise<ResearchChunk[]>;
  searchGlobalGraph(query: string, options?: MainMemorySearchOptions): Promise<{
    entities: OntologyEntity[];
    relations: OntologyRelation[];
    constraints: OntologyConstraint[];
  }>;
  promoteValidatedMemoryItem(item: GlobalMemoryItem): Promise<void>;
}

export interface MainMemorySearchOptions {
  projectId?: string;
  limit?: number;
  includeEphemeral?: boolean;
}
