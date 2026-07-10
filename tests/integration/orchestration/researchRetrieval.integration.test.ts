import { describe, expect, it } from "vitest";
import { EvidenceNormalizer } from "../../../src/core/evidence/evidenceNormalizer.js";
import { LoopDecisionEngine } from "../../../src/core/planning/loopDecision.js";
import { ReasoningEngine } from "../../../src/core/reasoning/reasoningEngine.js";
import { ResultSynthesizer } from "../../../src/core/reasoning/resultSynthesizer.js";
import { ValidationEngine } from "../../../src/core/reasoning/validationEngine.js";
import { HybridRetrievalEngine } from "../../../src/core/retrieval/hybridRetrievalEngine.js";
import { OntologyGraphEngine } from "../../../src/core/retrieval/ontologyGraphEngine.js";
import { ProjectContextBuilder, ProjectContextSelectionError } from "../../../src/core/retrieval/projectContextBuilder.js";
import { VectorIndexEngine } from "../../../src/core/retrieval/vectorIndexEngine.js";
import { DeterministicEmbeddingProvider } from "../../../src/core/testing/orchestratorTestHarness.js";
import { createdAt, settings, snapshot, supportRecord } from "./researchArchitecture.integration.support.js";

describe("Research normalization and retrieval architecture", () => {
  it("normalizes, indexes, builds ontology, retrieves hybrid context, validates, and decides continuation", async () => {
    const base = snapshot();
    const records = new EvidenceNormalizer().normalize(base, 1);
    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining(["source", "artifact", "claim", "evidence", "citation"]));
    expect(
      records.some((record) => record.sourceUri?.startsWith("project://research-input/") && record.metadata.traceabilityKind === "project_provenance")
    ).toBe(true);
    expect(records.some((record) => record.sourceUri?.startsWith("project://research-specification/") && record.metadata.canSupportHypothesis === false)).toBe(
      true
    );
    expect(records.some((record) => record.kind === "artifact" && record.metadata.traceabilityKind === "internal_artifact")).toBe(true);
    expect(records.some((record) => record.metadata.traceabilityKind === "external_source" && record.memoryScope === "global")).toBe(true);
    expect(records.some((record) => record.metadata.traceabilityKind === "project_provenance" && record.memoryScope === "project_only")).toBe(true);
    expect(records.some((record) => record.metadata.traceabilityKind === "internal_artifact" && record.memoryScope === "project_only")).toBe(true);
    expect(records.find((record) => record.evidenceId === "gap1")?.confidence).toBeLessThan(0.5);

    const weakWebBase = {
      ...base,
      sources: [
        ...base.sources,
        {
          id: "weak-source",
          projectId: "project-1",
          kind: "web" as const,
          title: "Community wiki page",
          url: "https://namu.wiki/w/pomodoro",
          retrievedAt: createdAt,
          metadata: {},
          createdAt
        }
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
    const hybrid = await new HybridRetrievalEngine(provider).buildContextFromProjectContext(
      { ...withGraph, projectContextSnapshots: [evidenceOnlyContext] },
      evidenceOnlyContext,
      1
    );
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
    const context = new ProjectContextBuilder().build(
      {
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
      },
      1
    );

    expect(context.selectedRecordIds).toContain(parentRecord.id);
    expect(context.selectedChunkIds).toContain("selected-chunk-from-missed-record");
    expect(context.selectedEntityIds).toEqual(expect.arrayContaining(["selected-entity-from-missed-record", "selected-hypothesis-from-missed-record"]));
    expect(context.selectedRelationIds).toContain("selected-relation-from-missed-record");
    expect(context.selectedEvidenceIds).toContain("e1");
    expect(context.selectionReason).toContain("Context candidates:");
    expect(context.selectionReason).toContain("Reverse-included parents:");
  });

  it("only selects support-eligible evidence ids from records, chunks, and graph provenance", () => {
    const base = snapshot();
    const records = [
      supportRecord("eligible-record", "eligible-evidence", "external_source", "scholarly", true),
      supportRecord("internal-record", "internal-evidence", "internal_artifact", "scholarly", true),
      supportRecord("weak-record", "weak-evidence", "external_source", "general_web", true)
    ];

    const context = new ProjectContextBuilder().build(
      {
        ...base,
        normalizedRecords: records,
        chunks: [
          {
            id: "eligible-chunk",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "indexed",
            sourceId: "s1",
            text: "Pomodoro fatigue eligible chunk",
            chunkIndex: 0,
            keywords: [],
            recordId: "eligible-record",
            evidenceId: "eligible-evidence",
            citation: "https://example.com/eligible",
            traceabilityKind: "external_source",
            sourceQualityTier: "scholarly",
            canSupportHypothesis: true,
            createdAt
          },
          {
            id: "internal-chunk",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "indexed",
            sourceId: "s1",
            text: "Pomodoro fatigue internal chunk",
            chunkIndex: 1,
            keywords: [],
            recordId: "internal-record",
            evidenceId: "internal-evidence",
            citation: "project://artifact/internal",
            traceabilityKind: "internal_artifact",
            sourceQualityTier: "scholarly",
            canSupportHypothesis: true,
            createdAt
          },
          {
            id: "weak-chunk",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "indexed",
            sourceId: "s1",
            text: "Pomodoro fatigue weak chunk",
            chunkIndex: 2,
            keywords: [],
            recordId: "weak-record",
            evidenceId: "weak-evidence",
            citation: "https://example.com/weak",
            traceabilityKind: "external_source",
            sourceQualityTier: "general_web",
            canSupportHypothesis: true,
            createdAt
          }
        ],
        ontologyEntities: [
          {
            id: "eligible-entity",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "graph_linked",
            label: "Pomodoro evidence",
            type: "Evidence",
            sourceRecordId: "eligible-record",
            sourceEvidenceId: "eligible-evidence",
            confidence: 0.9,
            createdAt
          },
          {
            id: "internal-entity",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "graph_linked",
            label: "Pomodoro internal",
            type: "Evidence",
            sourceRecordId: "internal-record",
            sourceEvidenceId: "internal-evidence",
            confidence: 0.9,
            createdAt
          }
        ],
        ontologyRelations: [
          {
            id: "eligible-relation",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "graph_linked",
            subjectId: "eligible-entity",
            predicate: "supports",
            objectId: "h1",
            sourceRecordId: "eligible-record",
            sourceEvidenceId: "eligible-evidence",
            confidence: 0.9,
            createdAt
          },
          {
            id: "internal-relation",
            projectId: base.project.id,
            memoryScope: "global",
            validationStatus: "graph_linked",
            subjectId: "internal-entity",
            predicate: "supports",
            objectId: "h1",
            sourceRecordId: "internal-record",
            sourceEvidenceId: "internal-evidence",
            confidence: 0.9,
            createdAt
          }
        ]
      },
      1
    );

    expect(context.selectedEvidenceIds).toContain("eligible-evidence");
    expect(context.selectedEvidenceIds).not.toContain("internal-evidence");
    expect(context.selectedEvidenceIds).not.toContain("weak-evidence");
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
          {
            id: "selected-chunk",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "indexed",
            sourceId: "s1",
            text: "Pomodoro 25/5 selected fatigue chunk",
            chunkIndex: 0,
            keywords: [],
            recordId: "selected-artifact-record",
            evidenceId: "e1",
            citation: "selected citation",
            createdAt
          },
          {
            id: "unselected-chunk",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "indexed",
            sourceId: "s1",
            text: "Pomodoro 25/5 unselected fatigue chunk with higher match",
            chunkIndex: 1,
            keywords: [],
            evidenceId: "gap1",
            citation: "unselected citation",
            createdAt
          }
        ],
        ontologyEntities: [
          {
            id: "selected-entity",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "graph_linked",
            label: "Pomodoro selected",
            type: "Concept",
            confidence: 0.5,
            createdAt
          },
          {
            id: "unselected-entity",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "graph_linked",
            label: "Pomodoro unselected",
            type: "Concept",
            confidence: 1,
            createdAt
          }
        ],
        ontologyRelations: [
          {
            id: "selected-relation",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "graph_linked",
            subjectId: "selected-entity",
            predicate: "supports",
            objectId: "unselected-entity",
            sourceEvidenceId: "e1",
            confidence: 0.9,
            createdAt
          },
          {
            id: "unselected-relation",
            projectId: base.project.id,
            memoryScope: "project_only",
            validationStatus: "graph_linked",
            subjectId: "unselected-entity",
            predicate: "supports",
            objectId: "selected-entity",
            sourceEvidenceId: "gap1",
            confidence: 1,
            createdAt
          }
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
});
