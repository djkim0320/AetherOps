import { FinalOutputWriter } from "../output/finalOutputWriter.js";
import { HybridRetrievalEngine } from "../retrieval/hybridRetrievalEngine.js";
import { createId, nowIso } from "../shared/ids.js";
import { buildResearchReport } from "../output/report.js";
import { buildBenchmarkPlan } from "../output/runAuditWriter.js";
import { VectorIndexEngine } from "../retrieval/vectorIndexEngine.js";
import { mergeEvidenceScorecards, scoreFinalResultClaims } from "../reasoning/evidenceScorecard.js";
import { activeMemorySearchStore, activeResearchSnapshot, counts, findLastByIteration, idsOf } from "./researchState.js";
import { INTERNAL_LOOP_SAFETY_CAP, nextIteration } from "./loopStateMachine.js";
import { ResearchLoopStep, type ContinuationDecision, type EvidenceBasedResult, type ResearchArtifact, type ResearchSnapshot } from "../shared/types.js";
import { ExecutionOrchestrator } from "./executionOrchestrator.js";
import { assertCitationPreservingResult, withCitationPreservationLine } from "./orchestratorResultHelpers.js";
export abstract class AnalysisOrchestrator extends ExecutionOrchestrator {
  async normalizeData(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.moveProject(projectId, ResearchLoopStep.NormalizeData);
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", "수집 데이터를 정규화합니다.");
    await this.ingestSources(projectId);
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const activeIteration = iteration ?? nextIteration(snapshot);
    const records = this.normalizer.normalize(snapshot, activeIteration);
    await this.store.saveNormalizedRecords(records);
    const snapshotWithRecords = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const compressionRecords = this.contextCompression.build(snapshotWithRecords, activeIteration);
    if (compressionRecords.length) {
      await this.store.saveNormalizedRecords(compressionRecords);
      await this.record(
        projectId,
        ResearchLoopStep.NormalizeData,
        "Knowledge Flow",
        `Context compression stored ${compressionRecords.length} source-backed memory record(s) for iteration ${activeIteration}.`
      );
    }
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", `정규화 레코드 ${records.length}개를 Main Research Memory에 저장했습니다.`);
    return this.store.getSnapshot(projectId);
  }

  async buildVectorIndex(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildVectorIndex);
    await this.moveProject(projectId, ResearchLoopStep.BuildVectorIndex);
    await this.record(projectId, ResearchLoopStep.BuildVectorIndex, "Knowledge Flow", "Main Vector Index 구축을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const database = await this.requireDatabase(projectId);
    const settings = await this.getSettings();
    const chunks = await new VectorIndexEngine(this.embeddingProvider).buildIndex({
      snapshot,
      records: snapshot.normalizedRecords,
      settings
    });
    if (chunks.length) {
      await this.projectStorage.writeChunks(snapshot.project, database, chunks);
      await this.store.saveChunks(chunks);
      const indexedRecordIds = new Set<string>();
      for (const chunk of chunks) {
        if (chunk.recordId) indexedRecordIds.add(chunk.recordId);
      }
      const indexedRecords: ResearchSnapshot["normalizedRecords"] = [];
      for (const record of snapshot.normalizedRecords) {
        if (!indexedRecordIds.has(record.id)) continue;
        indexedRecords.push({ ...record, validationStatus: record.validationStatus === "normalized" ? "indexed" : record.validationStatus });
      }
      await this.store.saveNormalizedRecords(indexedRecords);
    }
    const ragContext = await this.ragEngine.buildContext(activeResearchSnapshot(await this.store.getSnapshot(projectId)));
    await this.store.saveRagContext(ragContext);
    await this.record(projectId, ResearchLoopStep.BuildVectorIndex, "Knowledge Flow", `Main Vector Index를 구축했습니다. chunk=${chunks.length}.`);
    return this.store.getSnapshot(projectId);
  }

  async buildOntologyGraph(projectId: string): Promise<ResearchSnapshot> {
    await this.assertStepReady(projectId, ResearchLoopStep.BuildOntologyGraph);
    await this.moveProject(projectId, ResearchLoopStep.BuildOntologyGraph);
    await this.record(projectId, ResearchLoopStep.BuildOntologyGraph, "Knowledge Flow", "Main Ontology Graph 생성을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const database = await this.requireDatabase(projectId);
    const graph = this.ontologyGraph.build({
      snapshot,
      records: snapshot.normalizedRecords,
      specification: snapshot.specifications.at(-1)
    });
    await this.store.saveOntologyEntities(graph.entities);
    await this.store.saveOntologyRelations(graph.relations);
    await this.store.saveOntologyConstraints(graph.constraints);
    await this.projectStorage.writeOntologyGraph(snapshot.project, database, { ...graph, exportedAt: nowIso() });
    const graphRecordIds = new Set<string>();
    for (const entity of graph.entities) {
      if (entity.sourceRecordId) graphRecordIds.add(entity.sourceRecordId);
    }
    for (const relation of graph.relations) {
      if (relation.sourceRecordId) graphRecordIds.add(relation.sourceRecordId);
    }
    for (const constraint of graph.constraints) {
      if (constraint.sourceRecordId) graphRecordIds.add(constraint.sourceRecordId);
    }
    if (graphRecordIds.size) {
      const graphLinkedRecords: ResearchSnapshot["normalizedRecords"] = [];
      for (const record of snapshot.normalizedRecords) {
        if (!graphRecordIds.has(record.id)) continue;
        graphLinkedRecords.push({
          ...record,
          validationStatus: record.validationStatus === "normalized" || record.validationStatus === "indexed" ? "graph_linked" : record.validationStatus
        });
      }
      await this.store.saveNormalizedRecords(graphLinkedRecords);
    }
    await this.record(
      projectId,
      ResearchLoopStep.BuildOntologyGraph,
      "Knowledge Flow",
      `Main Ontology Graph를 생성했습니다. entities=${graph.entities.length}, relations=${graph.relations.length}.`
    );
    return this.store.getSnapshot(projectId);
  }

  async reasonAndValidate(projectId: string, iteration?: number): Promise<ResearchSnapshot> {
    await this.moveProject(projectId, ResearchLoopStep.ReasonAndValidate);
    await this.record(projectId, ResearchLoopStep.ReasonAndValidate, "Agent Control", "ProjectContextSnapshot 기반 추론과 검증을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const activeIteration = iteration ?? nextIteration(snapshot);
    const contextSnapshot = await this.projectContextBuilder.buildFromMainMemory({
      snapshot,
      iteration: activeIteration,
      store: activeMemorySearchStore(this.store, snapshot)
    });
    if (
      !contextSnapshot.selectedRecordIds.length &&
      !contextSnapshot.selectedChunkIds.length &&
      !contextSnapshot.selectedEntityIds.length &&
      !contextSnapshot.selectedRelationIds.length
    ) {
      throw new Error("ProjectContextSnapshot could not select any Main Research Memory context for validation.");
    }
    await this.store.saveProjectContextSnapshot(contextSnapshot);
    const afterContext = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const hybridContext = await new HybridRetrievalEngine(this.embeddingProvider).buildContextFromProjectContext(
      afterContext,
      contextSnapshot,
      activeIteration
    );
    await this.store.saveHybridContext(hybridContext);
    const contextAwareSnapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const reasoning = this.reasoning.reason(contextAwareSnapshot, hybridContext);
    const validations = this.validation.validate(contextAwareSnapshot, hybridContext, reasoning);
    await this.store.saveValidationResults(validations);
    const validatedEvidenceIds = new Set<string>();
    for (const validation of validations) {
      for (const evidenceId of validation.supportingEvidenceIds) validatedEvidenceIds.add(evidenceId);
      for (const evidenceId of validation.contradictingEvidenceIds) validatedEvidenceIds.add(evidenceId);
    }
    if (validatedEvidenceIds.size) {
      const validatedRecords: ResearchSnapshot["normalizedRecords"] = [];
      for (const record of contextAwareSnapshot.normalizedRecords) {
        if (!record.evidenceId || !validatedEvidenceIds.has(record.evidenceId) || record.kind !== "evidence") continue;
        validatedRecords.push({ ...record, validationStatus: "validated" as const });
      }
      await this.store.saveNormalizedRecords(validatedRecords);
    }
    await this.record(
      projectId,
      ResearchLoopStep.ReasonAndValidate,
      "Agent Control",
      `Hybrid retrieval 문맥으로 검증 결과 ${validations.length}개를 생성했습니다.`
    );
    return this.store.getSnapshot(projectId);
  }

  async synthesizeAndEvaluate(projectId: string, iteration?: number, forceStop = false): Promise<EvidenceBasedResult> {
    await this.assertStepReady(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    await this.moveProject(projectId, ResearchLoopStep.SynthesizeAndEvaluate);
    await this.record(projectId, ResearchLoopStep.SynthesizeAndEvaluate, "Agent Control", "ProjectContextSnapshot 기반 결과 합성을 시작합니다.");
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const activeIteration = iteration ?? nextIteration(snapshot);
    const contextSnapshot = findLastByIteration(snapshot.projectContextSnapshots, activeIteration);
    if (!contextSnapshot) {
      throw new Error(`ProjectContextSnapshot is required before synthesis for iteration ${activeIteration}.`);
    }
    const hybridContext = findLastByIteration(snapshot.hybridContexts, activeIteration);
    if (!hybridContext) {
      throw new Error(`HybridContext is required before synthesis for iteration ${activeIteration}.`);
    }
    const latestValidations: ResearchSnapshot["validationResults"] = [];
    for (const result of snapshot.validationResults) {
      if (result.iteration === activeIteration) latestValidations.push(result);
    }
    if (!latestValidations.length) {
      throw new Error(`ValidationResult is required before synthesis for iteration ${activeIteration}.`);
    }
    const draft = this.resultSynthesizer.synthesize({ snapshot, hybridContext, validationResults: latestValidations, forceStop });
    const llmResult = await this.tryLlmResult(
      { ...snapshot, hybridContexts: [...snapshot.hybridContexts, hybridContext], validationResults: latestValidations },
      activeIteration,
      forceStop
    );
    const mergedResultBase: EvidenceBasedResult = {
      ...draft,
      ...llmResult,
      id: llmResult.id,
      validationResultIds: idsOf(latestValidations),
      hybridContextId: hybridContext.id,
      hypothesisUpdates: llmResult.hypothesisUpdates.length ? llmResult.hypothesisUpdates : draft.hypothesisUpdates,
      quantitativeResults: llmResult.quantitativeResults.length ? llmResult.quantitativeResults : draft.quantitativeResults,
      qualitativeResults: withCitationPreservationLine(
        llmResult.qualitativeResults.length ? llmResult.qualitativeResults : draft.qualitativeResults,
        hybridContext.citations
      ),
      evidenceScorecard: undefined,
      metadata: {
        ...(draft.metadata ?? {}),
        ...(llmResult.metadata ?? {})
      }
    };
    const result: EvidenceBasedResult = {
      ...mergedResultBase,
      evidenceScorecard: mergeEvidenceScorecards([
        ...latestValidations.map((validation) => validation.claimScorecard),
        llmResult.evidenceScorecard,
        scoreFinalResultClaims({
          snapshot,
          hybridContext,
          validationResults: latestValidations,
          result: mergedResultBase
        })
      ])
    };
    assertCitationPreservingResult(result, hybridContext);
    await this.store.saveResult(result);
    await this.applyHypothesisUpdates(projectId, result);
    await this.record(projectId, ResearchLoopStep.SynthesizeAndEvaluate, "Agent Control", "결과 합성과 근거 평가를 완료했습니다.");
    return result;
  }

  async decideContinuation(
    projectId: string,
    result: EvidenceBasedResult,
    beforeCounts?: { evidence: number; artifacts: number; chunks: number; entities: number; relations: number },
    iteration = result.iteration,
    safetyCapIterations = INTERNAL_LOOP_SAFETY_CAP
  ): Promise<ContinuationDecision> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    const decision = this.loopDecision.decide({
      snapshot,
      result,
      iteration,
      safetyCapIterations,
      beforeCounts: beforeCounts ?? counts(snapshot)
    });
    await this.store.saveContinuationDecision(decision);
    await this.moveProject(projectId, ResearchLoopStep.DecideContinuation);
    await this.record(
      projectId,
      ResearchLoopStep.DecideContinuation,
      decision.shouldContinue ? "Loop Back" : "Output Flow",
      decision.shouldContinue ? "추가 연구가 필요하여 다음 iteration 계획 단계로 이동합니다." : "추가 연구가 필요하지 않아 최종 출력 단계로 이동합니다."
    );
    return decision;
  }

  async finalizeOutputs(projectId: string): Promise<ResearchSnapshot> {
    const snapshot = activeResearchSnapshot(await this.store.getSnapshot(projectId));
    if (
      snapshot.project.status === "paused" ||
      snapshot.project.status === "aborted" ||
      snapshot.project.status === "failed" ||
      snapshot.project.status === "blocked"
    ) {
      return snapshot;
    }
    await this.assertStepReady(projectId, ResearchLoopStep.FinalizeOutputs);
    await this.moveProject(projectId, ResearchLoopStep.FinalizeOutputs);
    await this.record(projectId, ResearchLoopStep.FinalizeOutputs, "Output Flow", "최종 결과와 Main Research Memory 승격을 시작합니다.");
    const database = await this.requireDatabase(projectId);
    const output = await new FinalOutputWriter(this.projectStorage).write(snapshot, database);
    const report = buildResearchReport(snapshot);
    await this.store.saveReport({ ...report, reportPath: output.reportPath, knowledgePath: `${snapshot.project.projectRoot}/knowledge/reusable-knowledge.md` });
    await this.store.saveFinalResearchOutput(output);
    const promotionSnapshot = await this.store.getSnapshot(projectId);
    const promoted = this.memoryPromotion.promote(promotionSnapshot);
    if (promoted.length) await this.store.saveGlobalMemoryItems(promoted);
    await this.store.saveBenchmarkPlan(buildBenchmarkPlan(promotionSnapshot));
    await this.moveProject(projectId, ResearchLoopStep.FinalizeOutputs, "completed");
    await this.record(
      projectId,
      ResearchLoopStep.FinalizeOutputs,
      "Output Flow",
      `최종 보고서, 데이터 export, artifact package를 생성했습니다. promoted memory item=${promoted.length}.`
    );
    return this.store.getSnapshot(projectId);
  }

  async storeArtifact(projectId: string, artifact: Partial<ResearchArtifact>): Promise<ResearchSnapshot> {
    const snapshot = await this.store.getSnapshot(projectId);
    const iteration = Math.max(snapshot.legacyAgentRuns.length, 1);
    const savedArtifact: ResearchArtifact = {
      id: artifact.id ?? createId("artifact"),
      projectId,
      category: artifact.category ?? "generated_artifact",
      title: artifact.title ?? "Manual research artifact",
      relativePath: artifact.relativePath ?? `artifacts/iteration-${iteration}/manual-artifact.md`,
      mimeType: artifact.mimeType ?? "text/markdown",
      summary: artifact.summary ?? "User-added research artifact.",
      content: artifact.content ?? artifact.summary ?? "User-added research artifact.",
      createdAt: artifact.createdAt ?? nowIso()
    };
    const database = await this.requireDatabase(projectId);
    const [written] = await this.projectStorage.writeArtifacts(snapshot.project, database, iteration, [savedArtifact]);
    await this.store.saveArtifacts([written]);
    await this.record(projectId, ResearchLoopStep.NormalizeData, "Storage Flow", `${written.title} 결과물을 저장했습니다.`);
    return this.store.getSnapshot(projectId);
  }
}
