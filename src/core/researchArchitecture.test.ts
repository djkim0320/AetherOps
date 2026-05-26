import { describe, expect, it } from "vitest";
import { EvidenceNormalizer } from "./evidenceNormalizer.js";
import { HybridRetrievalEngine } from "./hybridRetrievalEngine.js";
import { LoopDecisionEngine } from "./loopDecision.js";
import { MemoryPromotionEngine } from "./memoryPromotion.js";
import { OntologyGraphEngine } from "./ontologyGraphEngine.js";
import { DeterministicEmbeddingProvider, DeterministicLlmProvider } from "./orchestratorTestHarness.test.js";
import { ProjectContextBuilder, ProjectContextSelectionError } from "./projectContextBuilder.js";
import { ReasoningEngine } from "./reasoningEngine.js";
import { ResearchPlanner } from "./researchPlanner.js";
import { ResearchSpecificationBuilder } from "./researchSpecification.js";
import { ResultSynthesizer } from "./resultSynthesizer.js";
import { WebSearchTool } from "./toolRegistry.js";
import { ValidationEngine } from "./validationEngine.js";
import { VectorIndexEngine } from "./vectorIndexEngine.js";
import { ResearchLoopStep, type AppSettings, type ResearchSnapshot } from "./types.js";

const createdAt = "2026-05-20T00:00:00.000Z";
const settings: AppSettings = {
  openCodeLlm: { source: "codex-oauth", model: "gpt-5.5" },
  openCode: { enabled: false, command: "opencode", provider: "openai", model: "gpt-5.5", timeoutMs: 180_000 },
  webSearch: { provider: "disabled" },
  embedding: { provider: "openai", model: "text-embedding-3-small", dimensions: 64, apiKey: "test-key", apiKeyConfigured: true },
  browserUse: { enabled: false, mode: "background", maxPages: 2, timeoutMs: 30_000, captureScreenshots: false },
  allowExternalSearch: false,
  allowCodeExecution: false,
  ontologyExtractionMode: "rule_based",
  finalOutputExport: { markdown: true, json: true, ontologyGraph: true, artifactPackage: true },
  updatedAt: createdAt
};

function snapshot(): ResearchSnapshot {
  return {
    project: {
      id: "project-1",
      goal: "Compare Pomodoro 25/5 and 50/10 for a two-hour study session.",
      topic: "Pomodoro 25/5 vs 50/10",
      scope: "focus fatigue completion",
      budget: "30 minutes",
      autonomyPolicy: { toolApproval: "suggested", allowExternalSearch: false, allowCodeExecution: false },
      createdAt,
      updatedAt: createdAt,
      currentStep: ResearchLoopStep.CreateResearchDb,
      status: "running",
      projectRoot: ".aetherops/test"
    },
    sessions: [],
    questions: [
      { id: "q1", projectId: "project-1", text: "Which method sustains focus better?", status: "open", createdAt },
      { id: "q2", projectId: "project-1", text: "Which method reduces fatigue?", status: "open", createdAt },
      { id: "q3", projectId: "project-1", text: "Which method improves task completion?", status: "open", createdAt }
    ],
    hypotheses: [
      { id: "h1", projectId: "project-1", questionId: "q1", statement: "25/5 may reduce fatigue.", status: "untested", confidence: 0.35, createdAt },
      { id: "h2", projectId: "project-1", questionId: "q3", statement: "50/10 may improve deep work.", status: "untested", confidence: 0.35, createdAt }
    ],
    evidence: [
      {
        id: "e1",
        projectId: "project-1",
        category: "web_source",
        title: "Study break observation",
        summary: "Frequent short breaks may help fatigue management during studying.",
        sourceId: "s1",
        sourceUri: "https://arxiv.org/abs/2401.00001",
        citation: "Open academic study-break paper - https://arxiv.org/abs/2401.00001",
        keywords: ["pomodoro", "breaks", "fatigue"],
        linkedHypothesisIds: ["h1"],
        reliabilityScore: 0.7,
        relevanceScore: 0.8,
        evidenceStrength: "strong",
        limitations: [],
        createdAt
      },
      {
        id: "gap1",
        projectId: "project-1",
        category: "experiment_log",
        title: "Search unavailable",
        summary: "External search is disabled.",
        keywords: ["evidence_gap", "tool_unavailable"],
        linkedHypothesisIds: ["h2"],
        reliabilityScore: 0.1,
        relevanceScore: 0.3,
        evidenceStrength: "weak",
        limitations: ["Gap log only."],
        createdAt
      }
    ],
    artifacts: [
      {
        id: "a1",
        projectId: "project-1",
        category: "generated_artifact",
        title: "Mini experiment design",
        relativePath: "artifacts/iteration-1/design.md",
        mimeType: "text/markdown",
        summary: "A mini experiment design for comparing 25/5 and 50/10.",
        content: "Measure focus, fatigue, and completion for Pomodoro 25/5 and 50/10.",
        createdAt
      }
    ],
    sources: [
      { id: "s1", projectId: "project-1", kind: "paper", title: "Study break observation", url: "https://arxiv.org/abs/2401.00001", retrievedAt: createdAt, metadata: {}, createdAt }
    ],
    researchInputs: [
      {
        id: "input-1",
        projectId: "project-1",
        researchQuestion: "Which Pomodoro pattern is better for a two-hour study session?",
        initialHypotheses: ["25/5 may reduce fatigue.", "50/10 may improve deep work."],
        constraints: ["No live experiment."],
        expectedOutputs: ["final report"],
        createdAt
      }
    ],
    chunks: [],
    toolRuns: [],
    agentPlans: [],
    researchPlans: [
      {
        id: "plan-1",
        projectId: "project-1",
        iteration: 1,
        objective: "Compare cited study-break evidence.",
        targetQuestions: ["q1", "q2"],
        targetHypotheses: ["h1", "h2"],
        requiredTools: ["OpenCodeTool"],
        expectedSources: ["web source"],
        expectedArtifacts: ["comparison note"],
        executionSteps: ["Collect sources", "Normalize evidence"],
        stopCriteria: ["Cited evidence covers hypotheses"],
        createdAt
      }
    ],
    specifications: [
      {
        id: "spec-1",
        projectId: "project-1",
        researchQuestions: ["Which method sustains focus better?", "Which method reduces fatigue?", "Which method improves task completion?"],
        initialHypotheses: ["25/5 may reduce fatigue.", "50/10 may improve deep work."],
        refinedHypotheses: ["25/5 reduces fatigue better than 50/10.", "50/10 improves deep-work completion better than 25/5."],
        scope: "Two-hour study session.",
        assumptions: ["No live experiment."],
        constraints: ["Avoid medical certainty."],
        successCriteria: ["Cited evidence and clear limitations."],
        requiredEvidenceTypes: ["web source", "citation"],
        competencyQuestions: ["Which hypothesis has cited support?"],
        evaluationMetrics: ["focus", "fatigue", "completion"],
        createdAt
      }
    ],
    normalizedRecords: [],
    ontologyEntities: [],
    ontologyRelations: [],
    ontologyConstraints: [],
    projectContextSnapshots: [],
    hybridContexts: [],
    validationResults: [],
    continuationDecisions: [],
    finalOutputs: [],
    runtimeBlockers: [],
    stepErrors: [],
    openCodeRuns: [],
    ragContexts: [],
    results: [],
    iterations: []
  };
}

describe("12-step research architecture modules", () => {
  it("builds specification and plan from project questions and hypotheses", async () => {
    const base = snapshot();
    const llm = new DeterministicLlmProvider();
    const spec = await new ResearchSpecificationBuilder(llm).build({
      project: base.project,
      questions: base.questions,
      hypotheses: base.hypotheses,
      evidence: base.evidence
    });
    expect(spec.researchQuestions.length).toBeGreaterThanOrEqual(3);
    expect(spec.refinedHypotheses.length).toBeGreaterThanOrEqual(2);
    expect(spec.competencyQuestions.length).toBeGreaterThan(0);
    expect(spec.requiredEvidenceTypes.length).toBeGreaterThan(0);
    expect(spec.successCriteria.length).toBeGreaterThan(0);

    const plan = await new ResearchPlanner(llm).plan({
      snapshot: base,
      specification: spec,
      iteration: 1,
      settings,
      availableTools: ["WebSearchTool", "WebFetchTool", "PaperMetadataTool", "PdfIngestionTool", "CodeExecutionTool", "ArtifactWriterTool", "DataAnalysisTool", "BackgroundBrowserTool"]
    });
    expect(plan.iteration).toBe(1);
    expect(plan.objective).toBeTruthy();
    expect(plan.requiredTools.length).toBeGreaterThan(0);
    expect(plan.expectedSources.length).toBeGreaterThan(0);
    expect(plan.stopCriteria.length).toBeGreaterThan(0);
  });

  it("normalizes, indexes, builds ontology, retrieves hybrid context, validates, and decides continuation", async () => {
    const base = snapshot();
    const records = new EvidenceNormalizer().normalize(base, 1);
    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining(["source", "artifact", "claim", "evidence", "citation"]));
    expect(records.some((record) => record.sourceUri?.startsWith("project://research-input/") && record.metadata.traceabilityKind === "project_provenance")).toBe(true);
    expect(records.some((record) => record.sourceUri?.startsWith("project://research-specification/") && record.metadata.canSupportHypothesis === false)).toBe(true);
    expect(records.some((record) => record.kind === "artifact" && record.metadata.traceabilityKind === "internal_artifact")).toBe(true);
    expect(records.some((record) => record.metadata.traceabilityKind === "external_source" && record.memoryScope === "global")).toBe(true);
    expect(records.some((record) => record.metadata.traceabilityKind === "project_provenance" && record.memoryScope === "project_only")).toBe(true);
    expect(records.some((record) => record.metadata.traceabilityKind === "internal_artifact" && record.memoryScope === "project_only")).toBe(true);
    expect(records.find((record) => record.evidenceId === "gap1")?.confidence).toBeLessThan(0.5);

    const weakWebBase = {
      ...base,
      sources: [
        ...base.sources,
        { id: "weak-source", projectId: "project-1", kind: "web" as const, title: "Community wiki page", url: "https://namu.wiki/w/pomodoro", retrievedAt: createdAt, metadata: {}, createdAt }
      ],
      evidence: [
        ...base.evidence,
        {
          id: "weak-web",
          projectId: "project-1",
          category: "web_source" as const,
          title: "Community wiki page",
          summary: "A weak tertiary/community source claims support.",
          sourceId: "weak-source",
          sourceUri: "https://namu.wiki/w/pomodoro",
          citation: "Community wiki page - https://namu.wiki/w/pomodoro",
          keywords: ["weak"],
          linkedHypothesisIds: ["h1"],
          reliabilityScore: 0.9,
          relevanceScore: 0.9,
          evidenceStrength: "strong" as const,
          limitations: [],
          createdAt
        }
      ]
    };
    const weakRecords = new EvidenceNormalizer().normalize(weakWebBase, 1);
    const weakRecord = weakRecords.find((record) => record.evidenceId === "weak-web" && record.title === "Community wiki page");
    expect(weakRecord?.kind).not.toBe("evidence");
    expect(weakRecord?.metadata.canSupportHypothesis).toBe(false);

    const provider = new DeterministicEmbeddingProvider(64);
    const chunks = await new VectorIndexEngine(provider).buildIndex({ snapshot: base, records, settings });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.embedding?.length).toBe(64);
    expect(chunks.some((chunk) => records.find((record) => record.id === chunk.recordId)?.kind === "error")).toBe(false);
    expect(chunks.every((chunk) => chunk.recordKind && chunk.traceabilityKind && typeof chunk.canSupportHypothesis === "boolean")).toBe(true);
    expect(chunks.some((chunk) => chunk.sourceQualityTier)).toBe(true);
    expect(chunks.some((chunk) => chunk.memoryScope === "global")).toBe(true);
    expect(chunks.every((chunk) => chunk.originProjectId && chunk.workspaceProjectId)).toBe(true);

    const withIndex = { ...base, normalizedRecords: records, chunks };
    const graph = new OntologyGraphEngine().build({ snapshot: withIndex, records });
    expect(graph.entities.length).toBeGreaterThan(0);
    expect(graph.relations.some((relation) => relation.predicate === "supports")).toBe(true);
    expect(graph.entities.every((entity) => entity.sourceRecordId || entity.sourceEvidenceId)).toBe(true);
    expect(graph.relations.every((relation) => relation.sourceRecordId || relation.sourceEvidenceId)).toBe(true);
    expect(graph.entities.some((entity) => entity.memoryScope === "global")).toBe(true);

    const withGraph = { ...withIndex, ontologyEntities: graph.entities, ontologyRelations: graph.relations, ontologyConstraints: graph.constraints };
    const projectContext = new ProjectContextBuilder().build(withGraph, 1);
    expect(projectContext.selectedRecordIds.length).toBeGreaterThan(0);
    expect(projectContext.citations.length).toBeGreaterThan(0);
    expect(projectContext.selectionReason).toContain("global=");
    expect(projectContext.selectionReason).toContain("project=");
    expect(projectContext.selectionReason).toContain("Excluded records:");
    const evidenceOnlyContext = {
      ...projectContext,
      selectedRecordIds: projectContext.selectedRecordIds.filter((id) => records.find((record) => record.id === id)?.kind !== "artifact")
    };
    const hybrid = await new HybridRetrievalEngine(provider).buildContextFromProjectContext({ ...withGraph, projectContextSnapshots: [evidenceOnlyContext] }, evidenceOnlyContext, 1);
    expect(hybrid.vectorChunkIds.length).toBeGreaterThan(0);
    expect(hybrid.citations.length).toBeGreaterThan(0);
    expect(hybrid.contextText).toContain("Vector Context");
    expect(hybrid.artifactIds).not.toContain("a1");

    const reasoning = new ReasoningEngine().reason(withGraph, hybrid);
    const validations = new ValidationEngine().validate(withGraph, hybrid, reasoning);
    expect(validations.some((validation) => validation.status === "supported" || validation.status === "partially_supported")).toBe(true);
    expect(validations.some((validation) => validation.status === "inconclusive" || validation.status === "not_tested")).toBe(true);

    const withValidation = { ...withGraph, hybridContexts: [hybrid], validationResults: validations };
    const result = new ResultSynthesizer().synthesize({ snapshot: withValidation, hybridContext: hybrid, validationResults: validations });
    const decision = new LoopDecisionEngine().decide({
      snapshot: { ...withValidation, results: [result] },
      result,
      iteration: 1,
      safetyCapIterations: 2,
      beforeCounts: { evidence: 0, artifacts: 0, chunks: 0, entities: 0, relations: 0 }
    });
    expect(decision.shouldContinue).toBe(true);
    expect(decision.nextObjective).toBeTruthy();
    expect(decision.planRevisionHints.join(" ")).toContain("Step 4");
  });

  it("fails project context selection when no eligible records exist", () => {
    const base = snapshot();
    expect(() => new ProjectContextBuilder().build({ ...base, normalizedRecords: [] }, 1)).toThrow(ProjectContextSelectionError);
  });

  it("builds project context from Main DB search results and rejects off-topic global memory", async () => {
    const base = snapshot();
    const records = [
      ...new EvidenceNormalizer().normalize(base, 1),
      {
        id: "off-topic-global",
        projectId: "other-project",
        workspaceProjectId: "other-project",
        sourceProjectId: "other-project",
        memoryScope: "global" as const,
        validationStatus: "normalized" as const,
        iteration: 1,
        kind: "source" as const,
        title: "Wind turbine gearbox lubrication",
        content: "gearbox viscosity turbine blade maintenance",
        metadata: { traceabilityKind: "external_source", canSupportHypothesis: true },
        confidence: 0.8,
        createdAt
      }
    ];
    const provider = new DeterministicEmbeddingProvider(64);
    const chunks = await new VectorIndexEngine(provider).buildIndex({ snapshot: base, records, settings });
    const graph = new OntologyGraphEngine().build({ snapshot: { ...base, normalizedRecords: records, chunks }, records });
    const calls: string[] = [];
    const context = await new ProjectContextBuilder().buildFromMainMemory({
      snapshot: base,
      iteration: 1,
      store: {
        async searchGlobalRecords(query) {
          calls.push(`records:${query}`);
          return records;
        },
        async searchGlobalChunks(query) {
          calls.push(`chunks:${query}`);
          return chunks;
        },
        async searchGlobalGraph(query) {
          calls.push(`graph:${query}`);
          return graph;
        }
      }
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain(base.project.topic);
    expect(context.selectedRecordIds).not.toContain("off-topic-global");
    expect(context.selectionReason).toContain("Main Research Memory search API");
    expect(context.selectionReason).toContain("lowRelevanceGlobal=");
  });

  it("keeps chunk and graph candidates when parent global records miss lexical record search", async () => {
    const base = snapshot();
    const parentRecord = {
      id: "parent-record-missed-by-record-search",
      projectId: "other-project",
      workspaceProjectId: base.project.id,
      sourceProjectId: "other-project",
      memoryScope: "global" as const,
      validationStatus: "indexed" as const,
      iteration: 1,
      kind: "evidence" as const,
      title: "Unrelated archival title",
      content: "gearbox viscosity turbine blade maintenance",
      sourceId: "selected-source",
      evidenceId: "e1",
      citation: "https://example.edu/chunk-hit",
      sourceUri: "https://example.edu/chunk-hit",
      metadata: { traceabilityKind: "external_source", canSupportHypothesis: true, sourceQualityTier: "scholarly" },
      confidence: 0.8,
      createdAt
    };
    const context = new ProjectContextBuilder().build({
      ...base,
      normalizedRecords: [parentRecord],
      chunks: [
        {
          id: "selected-chunk-from-missed-record",
          projectId: "other-project",
          workspaceProjectId: base.project.id,
          sourceProjectId: "other-project",
          memoryScope: "global",
          validationStatus: "indexed",
          sourceId: "selected-source",
          text: "Pomodoro 25/5 breaks reduce fatigue in a two-hour study session.",
          chunkIndex: 0,
          keywords: ["pomodoro", "fatigue"],
          recordId: parentRecord.id,
          evidenceId: "e1",
          citation: "https://example.edu/chunk-hit",
          recordKind: "evidence",
          traceabilityKind: "external_source",
          canSupportHypothesis: true,
          sourceQualityTier: "scholarly",
          createdAt
        }
      ],
      ontologyEntities: [
        {
          id: "selected-entity-from-missed-record",
          projectId: "other-project",
          workspaceProjectId: base.project.id,
          sourceProjectId: "other-project",
          memoryScope: "global",
          validationStatus: "graph_linked",
          label: "Pomodoro fatigue",
          type: "Concept",
          description: "Focus fatigue during Pomodoro study sessions",
          sourceRecordId: parentRecord.id,
          sourceEvidenceId: "e1",
          confidence: 0.8,
          createdAt
        },
        {
          id: "selected-hypothesis-from-missed-record",
          projectId: "other-project",
          workspaceProjectId: base.project.id,
          sourceProjectId: "other-project",
          memoryScope: "global",
          validationStatus: "graph_linked",
          label: "25/5 may reduce fatigue",
          type: "Hypothesis",
          sourceRecordId: parentRecord.id,
          sourceEvidenceId: "e1",
          confidence: 0.8,
          createdAt
        }
      ],
      ontologyRelations: [
        {
          id: "selected-relation-from-missed-record",
          projectId: "other-project",
          workspaceProjectId: base.project.id,
          sourceProjectId: "other-project",
          memoryScope: "global",
          validationStatus: "graph_linked",
          subjectId: "selected-entity-from-missed-record",
          predicate: "supports",
          objectId: "selected-hypothesis-from-missed-record",
          sourceRecordId: parentRecord.id,
          sourceEvidenceId: "e1",
          confidence: 0.9,
          createdAt
        }
      ]
    }, 1);

    expect(context.selectedRecordIds).toContain(parentRecord.id);
    expect(context.selectedChunkIds).toContain("selected-chunk-from-missed-record");
    expect(context.selectedEntityIds).toEqual(expect.arrayContaining(["selected-entity-from-missed-record", "selected-hypothesis-from-missed-record"]));
    expect(context.selectedRelationIds).toContain("selected-relation-from-missed-record");
    expect(context.selectedEvidenceIds).toContain("e1");
    expect(context.selectionReason).toContain("Context candidates:");
    expect(context.selectionReason).toContain("Reverse-included parents:");
  });

  it("builds hybrid context only from ProjectContextSnapshot selected ids", async () => {
    const base = snapshot();
    const provider = new DeterministicEmbeddingProvider(64);
    const hybrid = await new HybridRetrievalEngine(provider).buildContextFromProjectContext(
      {
        ...base,
        normalizedRecords: [
          {
            id: "selected-artifact-record",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "indexed",
            iteration: 1,
            kind: "artifact",
            title: "Selected artifact",
            content: "Selected artifact content",
            artifactId: "a1",
            metadata: { traceabilityKind: "internal_artifact", canSupportHypothesis: true },
            createdAt
          }
        ],
        chunks: [
          { id: "selected-chunk", projectId: base.project.id, memoryScope: "project_only", validationStatus: "indexed", sourceId: "s1", text: "Pomodoro 25/5 selected fatigue chunk", chunkIndex: 0, keywords: [], recordId: "selected-artifact-record", evidenceId: "e1", citation: "selected citation", createdAt },
          { id: "unselected-chunk", projectId: base.project.id, memoryScope: "project_only", validationStatus: "indexed", sourceId: "s1", text: "Pomodoro 25/5 unselected fatigue chunk with higher match", chunkIndex: 1, keywords: [], evidenceId: "gap1", citation: "unselected citation", createdAt }
        ],
        ontologyEntities: [
          { id: "selected-entity", projectId: base.project.id, memoryScope: "project_only", validationStatus: "graph_linked", label: "Pomodoro selected", type: "Concept", confidence: 0.5, createdAt },
          { id: "unselected-entity", projectId: base.project.id, memoryScope: "project_only", validationStatus: "graph_linked", label: "Pomodoro unselected", type: "Concept", confidence: 1, createdAt }
        ],
        ontologyRelations: [
          { id: "selected-relation", projectId: base.project.id, memoryScope: "project_only", validationStatus: "graph_linked", subjectId: "selected-entity", predicate: "supports", objectId: "unselected-entity", sourceEvidenceId: "e1", confidence: 0.9, createdAt },
          { id: "unselected-relation", projectId: base.project.id, memoryScope: "project_only", validationStatus: "graph_linked", subjectId: "unselected-entity", predicate: "supports", objectId: "selected-entity", sourceEvidenceId: "gap1", confidence: 1, createdAt }
        ]
      },
      {
        id: "context-selected-only",
        projectId: base.project.id,
        iteration: 1,
        query: "Pomodoro fatigue",
        selectedRecordIds: ["selected-artifact-record"],
        selectedSourceIds: [],
        selectedEvidenceIds: ["e1"],
        selectedChunkIds: ["selected-chunk"],
        selectedEntityIds: ["selected-entity"],
        selectedRelationIds: ["selected-relation"],
        citations: ["selected context citation"],
        selectionReason: "selected ids only",
        createdAt
      },
      1
    );

    expect(hybrid.vectorChunkIds).toEqual(["selected-chunk"]);
    expect(hybrid.ontologyEntityIds).toEqual(["selected-entity"]);
    expect(hybrid.ontologyRelationIds).toEqual(["selected-relation"]);
    expect(hybrid.evidenceIds).toEqual(["e1"]);
    expect(hybrid.artifactIds).toEqual(["a1"]);
    expect(hybrid.citations).toEqual(expect.arrayContaining(["selected citation", "selected context citation"]));
    expect(hybrid.citations).not.toContain("unselected citation");
  });

  it("adds a WebFetch revision hint only when selected context has external source candidates without evidence", () => {
    const base = snapshot();
    const result = {
      id: "result-fetch-hint",
      projectId: base.project.id,
      iteration: 1,
      answer: "Source candidates require fetch.",
      hypothesisUpdates: [],
      quantitativeResults: [],
      qualitativeResults: [],
      nextQuestions: [],
      needsMoreEvidence: false,
      needsMoreAnalysis: false,
      ragContextId: undefined,
      createdAt
    };
    const decision = new LoopDecisionEngine().decide({
      snapshot: {
        ...base,
        projectContextSnapshots: [
          {
            id: "context-fetch",
            projectId: base.project.id,
            iteration: 1,
            query: "Pomodoro",
            selectedRecordIds: [],
            selectedSourceIds: ["s1"],
            selectedEvidenceIds: [],
            selectedChunkIds: [],
            selectedEntityIds: [],
            selectedRelationIds: [],
            citations: ["https://arxiv.org/abs/2401.00001"],
            selectionReason: "external source candidate",
            createdAt
          }
        ]
      },
      result,
      iteration: 1,
      safetyCapIterations: 3,
      beforeCounts: { evidence: base.evidence.length, artifacts: base.artifacts.length, chunks: 0, entities: 0, relations: 0 }
    });

    expect(decision.shouldContinue).toBe(true);
    expect(decision.evidenceGaps).toContain("Source candidates found but not fetched into citation-backed evidence");
    expect(decision.planRevisionHints).toContain("Use WebFetchTool to fetch selected source URLs.");
  });

  it("does not turn web search snippets or internal artifacts into support evidence", async () => {
    const base = snapshot();
    const tool = new WebSearchTool();
    (tool as unknown as { search: () => Promise<Array<{ title: string; url: string; snippet: string }>> }).search = async () => [
      { title: "Search only result", url: "https://example.edu/search-result", snippet: "Snippet is not verified evidence." }
    ];
    const result = await tool.run(
      {
        project: { ...base.project, autonomyPolicy: { ...base.project.autonomyPolicy, allowExternalSearch: true } },
        questions: base.questions,
        hypotheses: base.hypotheses,
        sources: base.sources,
        iteration: 1
      },
      { ...settings, allowExternalSearch: true, webSearch: { provider: "custom", apiKey: "test-key", endpoint: "https://example.test/search" } }
    );
    expect(result.sources).toHaveLength(1);
    expect(result.evidence).toHaveLength(0);

    const records = new EvidenceNormalizer().normalize({ ...base, artifacts: base.artifacts, evidence: [], sources: result.sources }, 1);
    expect(records.some((record) => record.kind === "evidence")).toBe(false);
    expect(records.some((record) => record.kind === "artifact" && record.metadata.canSupportHypothesis === false)).toBe(true);
  });

  it("promotes only validated citation-backed external evidence into global memory items", () => {
    const base = snapshot();
    const records = new EvidenceNormalizer().normalize(base, 1).map((record) =>
      record.evidenceId === "e1" && record.kind === "evidence" ? { ...record, validationStatus: "validated" as const } : record
    );
    const validation = {
      id: "validation-supported",
      projectId: base.project.id,
      iteration: 1,
      hypothesisId: "h1",
      status: "supported" as const,
      confidence: 0.8,
      supportingEvidenceIds: ["e1"],
      contradictingEvidenceIds: [],
      relatedEntityIds: [],
      relatedRelationIds: [],
      reasoningSummary: "External evidence supports the hypothesis.",
      limitations: [],
      evidenceGaps: [],
      createdAt
    };
    const promoted = new MemoryPromotionEngine().promote({ ...base, normalizedRecords: records, validationResults: [validation] });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.supportingEvidenceIds).toContain("e1");

    const notPromoted = new MemoryPromotionEngine().promote({
      ...base,
      normalizedRecords: records,
      validationResults: [{ ...validation, id: "validation-gap", status: "inconclusive", supportingEvidenceIds: [] }]
    });
    expect(notPromoted).toHaveLength(0);
  });
});
