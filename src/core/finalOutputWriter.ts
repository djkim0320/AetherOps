import type { ProjectStorage } from "./projectStorage.js";
import { buildResearchReport } from "./report.js";
import { createId, nowIso } from "./ids.js";
import type { FinalResearchOutput, ResearchDatabase, ResearchSnapshot } from "./types.js";

export class FinalOutputWriter {
  constructor(private readonly projectStorage: ProjectStorage) {}

  async write(snapshot: ResearchSnapshot, database: ResearchDatabase): Promise<FinalResearchOutput> {
    const report = buildResearchReport(snapshot);
    const graphExport = {
      projectId: snapshot.project.id,
      entities: snapshot.ontologyEntities,
      relations: snapshot.ontologyRelations,
      constraints: snapshot.ontologyConstraints,
      exportedAt: nowIso()
    };
    const artifactPackage = {
      projectId: snapshot.project.id,
      artifacts: snapshot.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        relativePath: artifact.relativePath,
        rawPath: artifact.rawPath,
        mimeType: artifact.mimeType,
        summary: artifact.summary
      })),
      toolRuns: snapshot.toolRuns,
      sources: snapshot.sources,
      exportedAt: nowIso()
    };
    const evidenceCitations = snapshot.evidence.map((evidence) => ({
      id: evidence.id,
      title: evidence.title,
      citation: evidence.citation,
      sourceUri: evidence.sourceUri,
      sourceId: evidence.sourceId,
      reliabilityScore: evidence.reliabilityScore,
      limitations: evidence.limitations
    }));
    const hypothesisVerification = snapshot.hypotheses.map((hypothesis) => ({
      id: hypothesis.id,
      statement: hypothesis.statement,
      status: hypothesis.status,
      confidence: hypothesis.confidence,
      validations: snapshot.validationResults.filter((validation) => validation.hypothesisId === hypothesis.id)
    }));
    const output: FinalResearchOutput = {
      id: createId("final"),
      projectId: snapshot.project.id,
      finalAnswer: report.answer,
      markdownReport: report.markdown ?? report.comprehensiveReport,
      hypothesisSummary: report.hypothesisVerification,
      evidenceCitationList: evidenceCitations.map((item) => item.citation ?? item.sourceUri ?? item.sourceId ?? item.title),
      reusableKnowledgeAsset: report.reusableKnowledgeAsset,
      createdAt: nowIso()
    };
    const files = this.projectStorage.writeFinalOutputFiles
      ? await this.projectStorage.writeFinalOutputFiles(snapshot.project, database, output, graphExport, artifactPackage, evidenceCitations, hypothesisVerification)
      : await this.projectStorage.writeReportFiles(snapshot.project, database, report, output.markdownReport, output.reusableKnowledgeAsset).then((paths) => ({
          ...paths,
          ontologyExportPath: "",
          artifactPackagePath: ""
        }));

    return {
      ...output,
      reportPath: files.reportPath,
      ontologyExportPath: files.ontologyExportPath,
      artifactPackagePath: files.artifactPackagePath
    };
  }
}
