import type {
  AgentPlan,
  BenchmarkPlan,
  ContinuationDecision,
  EvidenceBasedResult,
  EvidenceItem,
  FinalResearchOutput,
  GlobalMemoryItem,
  HybridContext,
  Hypothesis,
  LoopIteration,
  MainMemorySearchOptions,
  NormalizedResearchRecord,
  OntologyConstraint,
  OntologyEntity,
  OntologyRelation,
  LegacyAgentRun,
  ProjectContextSnapshot,
  RagContext,
  ResearchArtifact,
  ResearchChunk,
  ResearchDatabase,
  ResearchInput,
  ResearchPlan,
  ResearchProject,
  ResearchQuestion,
  ResearchReport,
  ResearchSession,
  ResearchSnapshot,
  ResearchSource,
  ResearchSpecification,
  ResearchStore,
  RunAuditOutput,
  RuntimeBlocker,
  StepError,
  ToolRun,
  ValidationResult
} from "../../../core/shared/types.js";
import { OPEN_CODE_RUNS_TABLE, SqliteStoreBase, type JsonRecord } from "./sqliteStoreBase.js";
import { applyLegacyProjectMutation, listLegacyProjectMutationReceipts, readLegacyProjectMutationReceipt } from "./legacyProjectMutationStore.js";
import { assertLegacyProjectMutationSchemaReady } from "./legacyProjectMutationSchema.js";
import type {
  LegacyProjectMutationApplyResult,
  LegacyProjectMutationReceipt,
  LegacyProjectMutationReceiptQuery,
  LegacyProjectMutationRequest
} from "./legacyProjectMutationTypes.js";
import { groupByProject, normalizeRecord, sanitizeProject, sanitizeSourceForSqlite, searchScopedItems } from "./sqliteStoreSupport.js";

export class SqliteResearchStore extends SqliteStoreBase implements ResearchStore {
  private legacyProjectMutationSchemaVersion: number | undefined;

  async applyProjectMutation(request: LegacyProjectMutationRequest): Promise<LegacyProjectMutationApplyResult> {
    this.assertLegacyProjectMutationsReady();
    return applyLegacyProjectMutation(this.db, request, (projectId) => this.snapshotSync(projectId));
  }
  async getProjectMutationReceipt(operationId: string): Promise<LegacyProjectMutationReceipt | undefined> {
    this.assertLegacyProjectMutationsReady();
    return readLegacyProjectMutationReceipt(this.db, operationId);
  }
  async listProjectMutationReceipts(query?: LegacyProjectMutationReceiptQuery): Promise<LegacyProjectMutationReceipt[]> {
    this.assertLegacyProjectMutationsReady();
    return listLegacyProjectMutationReceipts(this.db, query);
  }

  private assertLegacyProjectMutationsReady(): void {
    const current = Number((this.db.prepare("pragma schema_version").get() as { schema_version?: unknown }).schema_version);
    if (this.legacyProjectMutationSchemaVersion === current) return;
    assertLegacyProjectMutationSchemaReady(this.db);
    this.legacyProjectMutationSchemaVersion = current;
  }

  async saveProject(project: ResearchProject): Promise<void> {
    this.upsertProject(project);
  }
  async updateProject(project: ResearchProject): Promise<void> {
    this.upsertProject(project);
  }

  async listProjects(): Promise<ResearchProject[]> {
    return this.all("projects")
      .map((row) => sanitizeProject(this.parse<ResearchProject>(row)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async getProject(projectId: string): Promise<ResearchProject | undefined> {
    const row = this.db.prepare("select id, data from projects where id = ?").get(projectId) as JsonRecord | undefined;
    return row ? sanitizeProject(this.parse<ResearchProject>(row)) : undefined;
  }

  async saveSessions(items: ResearchSession[]): Promise<void> {
    this.upsertMany("sessions", items);
  }
  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    this.db.prepare("delete from sessions where project_id = ? and id = ?").run(projectId, sessionId);
  }
  async saveDatabase(item: ResearchDatabase): Promise<void> {
    this.upsertMany("research_databases", [item]);
  }
  async saveResearchInput(item: ResearchInput): Promise<void> {
    this.upsertMany("research_inputs", [item]);
    this.upsertManyProject(item.projectId, "research_inputs", [item]);
  }
  async saveQuestions(items: ResearchQuestion[]): Promise<void> {
    this.upsertMany("questions", items);
  }
  async saveHypotheses(items: Hypothesis[]): Promise<void> {
    this.upsertMany("hypotheses", items);
  }
  async saveEvidence(items: EvidenceItem[]): Promise<void> {
    this.upsertMany("evidence", items);
    this.upsertManyMain("global_evidence", items);
  }
  async saveArtifacts(items: ResearchArtifact[]): Promise<void> {
    this.upsertMany("artifacts", items);
    this.upsertManyMain("global_artifacts", items);
  }

  async saveSources(items: ResearchSource[]): Promise<void> {
    const normalized = items.map((source) => sanitizeSourceForSqlite({ ...source, createdAt: source.createdAt ?? source.retrievedAt }));
    this.upsertMany("sources", normalized);
    this.upsertManyMain("global_sources", normalized);
  }

  async saveChunks(items: ResearchChunk[]): Promise<void> {
    this.upsertMany("chunks", items);
    this.upsertManyInto(this.mainVectorDb, "global_chunks", items);
    this.linkProjectItems(
      "project_chunk_links",
      items.map((item) => ({ projectId: item.workspaceProjectId ?? item.projectId, itemId: item.id, createdAt: item.createdAt }))
    );
  }

  async saveToolRuns(items: ToolRun[]): Promise<void> {
    this.upsertMany("tool_runs", items);
    this.upsertManyMain("global_tool_runs", items);
  }
  async saveAgentPlan(item: AgentPlan): Promise<void> {
    this.upsertMany("agent_plans", [item]);
  }
  async saveResearchSpecification(item: ResearchSpecification): Promise<void> {
    this.upsertMany("research_specifications", [item]);
    this.upsertManyProject(item.projectId, "research_specifications", [item]);
  }
  async saveResearchPlan(item: ResearchPlan): Promise<void> {
    this.upsertMany("research_plans", [item]);
    this.upsertMany("agent_plans", [item]);
    this.upsertManyProject(item.projectId, "research_plans", [item]);
  }

  async saveNormalizedRecords(items: NormalizedResearchRecord[]): Promise<void> {
    const normalized = items.map(normalizeRecord);
    this.upsertMany("normalized_records", normalized);
    this.upsertManyMain("global_normalized_records", normalized);
    this.upsertManyMain(
      "global_provenance",
      normalized.filter((item) => item.metadata.traceabilityKind === "project_provenance")
    );
    this.linkProjectItems(
      "project_record_links",
      normalized.map((item) => ({ projectId: item.workspaceProjectId ?? item.projectId, itemId: item.id, createdAt: item.createdAt }))
    );
  }

  async saveOntologyEntities(items: OntologyEntity[]): Promise<void> {
    this.upsertMany("ontology_entities", items);
    this.upsertManyInto(this.mainOntologyDb, "global_entities", items);
    this.linkProjectItems(
      "project_entity_links",
      items.map((item) => ({ projectId: item.workspaceProjectId ?? item.projectId, itemId: item.id, createdAt: item.createdAt }))
    );
  }

  async saveOntologyRelations(items: OntologyRelation[]): Promise<void> {
    this.upsertMany("ontology_relations", items);
    this.upsertManyInto(this.mainOntologyDb, "global_relations", items);
    this.linkProjectItems(
      "project_relation_links",
      items.map((item) => ({ projectId: item.workspaceProjectId ?? item.projectId, itemId: item.id, createdAt: item.createdAt }))
    );
  }

  async saveOntologyConstraints(items: OntologyConstraint[]): Promise<void> {
    this.upsertMany("ontology_constraints", items);
    this.upsertManyInto(this.mainOntologyDb, "global_constraints", items);
    this.linkProjectItems(
      "project_constraint_links",
      items.map((item) => ({ projectId: item.workspaceProjectId ?? item.projectId, itemId: item.id, createdAt: item.createdAt }))
    );
  }

  async saveProjectContextSnapshot(item: ProjectContextSnapshot): Promise<void> {
    this.upsertMany("project_context_snapshots", [item]);
    this.upsertManyProject(item.projectId, "project_context_snapshots", [item]);
  }
  async saveHybridContext(item: HybridContext): Promise<void> {
    this.upsertMany("hybrid_contexts", [item]);
    this.upsertManyProject(item.projectId, "hybrid_contexts", [item]);
  }
  async saveValidationResults(items: ValidationResult[]): Promise<void> {
    this.upsertMany("validation_results", items);
    for (const [projectId, group] of groupByProject(items)) this.upsertManyProject(projectId, "validation_results", group);
  }
  async saveContinuationDecision(item: ContinuationDecision): Promise<void> {
    this.saveProjectItem("continuation_decisions", item);
  }
  async saveFinalResearchOutput(item: FinalResearchOutput): Promise<void> {
    this.saveProjectItem("final_outputs", item);
  }
  async saveRunAuditOutput(item: RunAuditOutput): Promise<void> {
    this.saveProjectItem("run_audit_outputs", item);
  }
  async saveBenchmarkPlan(item: BenchmarkPlan): Promise<void> {
    this.saveProjectItem("benchmark_plans", item);
  }
  async saveGlobalMemoryItems(items: GlobalMemoryItem[]): Promise<void> {
    this.upsertMany("global_memory_items", items);
    this.upsertManyMain("global_memory_items", items);
  }
  async saveRuntimeBlocker(item: RuntimeBlocker): Promise<void> {
    this.upsertMany("runtime_blockers", [item]);
  }
  async saveStepError(item: StepError): Promise<void> {
    this.upsertMany("step_errors", [item]);
  }
  async saveLegacyAgentRun(item: LegacyAgentRun): Promise<void> {
    this.upsertMany(OPEN_CODE_RUNS_TABLE, [item]);
  }
  async saveRagContext(item: RagContext): Promise<void> {
    this.upsertMany("rag_contexts", [item]);
  }
  async saveResult(item: EvidenceBasedResult): Promise<void> {
    this.upsertMany("results", [item]);
  }
  async saveIteration(item: LoopIteration): Promise<void> {
    this.upsertMany("iterations", [item]);
  }
  async saveReport(item: ResearchReport): Promise<void> {
    this.upsertMany("reports", [item]);
  }

  async getSnapshot(projectId: string): Promise<ResearchSnapshot> {
    return this.snapshotSync(projectId);
  }

  private snapshotSync(projectId: string): ResearchSnapshot {
    const project = this.getProjectSync(projectId);
    if (!project) throw new Error(`Research project not found: ${projectId}`);
    return {
      project,
      sessions: this.byProject<ResearchSession>("sessions", projectId),
      database: this.byProject<ResearchDatabase>("research_databases", projectId).at(-1),
      researchInputs: this.byProject<ResearchInput>("research_inputs", projectId),
      questions: this.byProject<ResearchQuestion>("questions", projectId),
      hypotheses: this.byProject<Hypothesis>("hypotheses", projectId),
      evidence: this.byProject<EvidenceItem>("evidence", projectId),
      artifacts: this.byProject<ResearchArtifact>("artifacts", projectId),
      sources: this.byProject<ResearchSource>("sources", projectId),
      chunks: this.byProjectOrGlobalVisible<ResearchChunk>("chunks", projectId),
      toolRuns: this.byProject<ToolRun>("tool_runs", projectId),
      agentPlans: this.byProject<AgentPlan>("agent_plans", projectId),
      researchPlans: this.byProject<ResearchPlan>("research_plans", projectId),
      specifications: this.byProject<ResearchSpecification>("research_specifications", projectId),
      normalizedRecords: this.byProjectOrGlobalVisible<NormalizedResearchRecord>("normalized_records", projectId),
      ontologyEntities: this.byProjectOrGlobalVisible<OntologyEntity>("ontology_entities", projectId),
      ontologyRelations: this.byProjectOrGlobalVisible<OntologyRelation>("ontology_relations", projectId),
      ontologyConstraints: this.byProjectOrGlobalVisible<OntologyConstraint>("ontology_constraints", projectId),
      projectContextSnapshots: this.byProject<ProjectContextSnapshot>("project_context_snapshots", projectId),
      hybridContexts: this.byProject<HybridContext>("hybrid_contexts", projectId),
      validationResults: this.byProject<ValidationResult>("validation_results", projectId),
      continuationDecisions: this.byProject<ContinuationDecision>("continuation_decisions", projectId),
      finalOutputs: this.byProject<FinalResearchOutput>("final_outputs", projectId),
      runAuditOutputs: this.byProject<RunAuditOutput>("run_audit_outputs", projectId),
      benchmarkPlans: this.byProject<BenchmarkPlan>("benchmark_plans", projectId),
      globalMemoryItems: this.byProjectOrGlobalVisible<GlobalMemoryItem>("global_memory_items", projectId),
      runtimeBlockers: this.byProject<RuntimeBlocker>("runtime_blockers", projectId),
      stepErrors: this.byProject<StepError>("step_errors", projectId),
      legacyAgentRuns: this.byProject<LegacyAgentRun>(OPEN_CODE_RUNS_TABLE, projectId),
      ragContexts: this.byProject<RagContext>("rag_contexts", projectId),
      results: this.byProject<EvidenceBasedResult>("results", projectId),
      iterations: this.byProject<LoopIteration>("iterations", projectId),
      report: this.byProject<ResearchReport>("reports", projectId).at(-1)
    };
  }

  async searchGlobalRecords(query: string, options: MainMemorySearchOptions = {}): Promise<NormalizedResearchRecord[]> {
    return searchScopedItems(this.allParsedFrom<NormalizedResearchRecord>(this.mainDb, "global_normalized_records"), query, options);
  }

  async searchGlobalChunks(query: string, options: MainMemorySearchOptions = {}): Promise<ResearchChunk[]> {
    return searchScopedItems(
      this.allParsedFrom<ResearchChunk>(this.mainVectorDb, "global_chunks"),
      query,
      options,
      (chunk) => `${chunk.text}\n${chunk.keywords.join(" ")}\n${chunk.citation ?? ""}`
    );
  }

  async searchGlobalGraph(
    query: string,
    options: MainMemorySearchOptions = {}
  ): Promise<{ entities: OntologyEntity[]; relations: OntologyRelation[]; constraints: OntologyConstraint[] }> {
    const entities = searchScopedItems(
      this.allParsedFrom<OntologyEntity>(this.mainOntologyDb, "global_entities"),
      query,
      options,
      (entity) => `${entity.label}\n${entity.description ?? ""}`
    );
    const relations = entities.length ? this.visibleRelationsForEntities(new Set(entities.map((item) => item.id)), options, options.limit ?? 24) : [];
    const constraints = searchScopedItems(
      this.allParsedFrom<OntologyConstraint>(this.mainOntologyDb, "global_constraints"),
      query,
      options,
      (constraint) => `${constraint.label}\n${constraint.description}`
    );
    return { entities, relations, constraints };
  }

  private saveProjectItem<T extends { id: string; projectId: string; createdAt?: string; startedAt?: string }>(table: string, item: T): void {
    this.upsertMany(table, [item]);
    this.upsertManyProject(item.projectId, table, [item]);
  }
}
