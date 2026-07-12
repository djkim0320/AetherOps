import type { AppSettings, ResearchSnapshot } from "../shared/types.js";
import { hasExecutableEngineeringTool } from "./engineeringProgramTool.js";
import { listToolDescriptors } from "./toolDescriptors.js";
import { normalizeToolName, orderToolNames } from "./toolMerger.js";
import type { SourceAccessPolicy } from "./sourceAccessPolicy.js";

export interface ToolExecutableContext {
  snapshot: ResearchSnapshot;
  settings: AppSettings;
  toolPolicy?: { allowCodexCli: boolean; sourceAccess?: SourceAccessPolicy };
}

const standardExecutableToolNames = new Set(listToolDescriptors().map((descriptor) => normalizeToolName(descriptor.name)));

export function buildExecutableToolNames(registeredToolNames: string[], context: ToolExecutableContext): string[] {
  const registered = registeredToolNameMap(registeredToolNames);
  const externalAllowed = context.snapshot.project.autonomyPolicy.allowExternalSearch && context.settings.allowExternalSearch;
  const webSearchConfigured =
    context.settings.webSearch.provider !== "disabled" && Boolean(context.settings.webSearch.apiKey || context.settings.webSearch.apiKeyConfigured);
  const hasFetchCandidates = hasFetchCandidateUrls(context.snapshot) || hasContinuationFetchHint(context.snapshot);
  const hasPdfInputs = hasPdfInput(context.snapshot) || hasPolicyPdfInput(context.toolPolicy?.sourceAccess);
  const codeAllowed = context.snapshot.project.autonomyPolicy.allowCodeExecution && context.settings.allowCodeExecution;
  const researchMetadataReady = externalAllowed && context.settings.researchMetadata.enabled;
  const engineeringProgramReady = codeAllowed && hasExecutableEngineeringTool(context.settings);

  const customRegistered: string[] = [];
  for (const [normalizedName, registeredName] of registered) {
    if (!standardExecutableToolNames.has(normalizedName)) {
      customRegistered.push(registeredName);
    }
  }

  const candidates: string[] = [];
  pushRegisteredTool(candidates, registered, "WebSearchTool", externalAllowed && webSearchConfigured);
  pushRegisteredTool(candidates, registered, "BackgroundBrowserTool", externalAllowed && context.settings.browserUse.enabled);
  pushRegisteredTool(
    candidates,
    registered,
    "WebFetchTool",
    externalAllowed && (hasFetchCandidates || webSearchConfigured || context.settings.browserUse.enabled)
  );
  pushRegisteredTool(candidates, registered, "ResearchMetadataTool", researchMetadataReady);
  pushRegisteredTool(candidates, registered, "PdfIngestionTool", externalAllowed && hasPdfInputs);
  pushRegisteredTool(candidates, registered, "EngineeringProgramTool", engineeringProgramReady);
  pushRegisteredTool(candidates, registered, "CodexCliTool", codeAllowed && context.toolPolicy?.allowCodexCli === true);
  pushRegisteredTool(candidates, registered, "ArtifactWriterTool", true);
  pushRegisteredTool(candidates, registered, "DataAnalysisTool", true);
  for (const tool of customRegistered) candidates.push(tool);
  return orderToolNames(candidates);
}

export function buildProductionExecutableToolNames(settings: AppSettings): string[] {
  const externalAllowed = Boolean(settings.allowExternalSearch);
  const webSearchReady =
    settings.allowExternalSearch && settings.webSearch.provider !== "disabled" && Boolean(settings.webSearch.apiKey || settings.webSearch.apiKeyConfigured);
  const browserReady = settings.allowExternalSearch && settings.browserUse.enabled;
  const engineeringReady = settings.allowCodeExecution && hasExecutableEngineeringTool(settings);
  const candidates: string[] = [];
  if (webSearchReady) candidates.push("WebSearchTool");
  if (browserReady) candidates.push("BackgroundBrowserTool");
  if (webSearchReady || browserReady) candidates.push("WebFetchTool");
  if (settings.researchMetadata.enabled && externalAllowed) candidates.push("ResearchMetadataTool");
  if (externalAllowed) candidates.push("PdfIngestionTool");
  if (engineeringReady) candidates.push("EngineeringProgramTool");
  candidates.push("ArtifactWriterTool", "DataAnalysisTool");
  return orderToolNames(candidates);
}

function pushRegisteredTool(candidates: string[], registered: Map<string, string>, name: string, enabled: boolean): void {
  if (!enabled) return;
  const registeredName = registered.get(normalizeToolName(name));
  if (registeredName) candidates.push(registeredName);
}

function registeredToolNameMap(toolNames: string[]): Map<string, string> {
  const registered = new Map<string, string>();
  for (const toolName of toolNames) {
    registered.set(normalizeToolName(toolName), toolName);
  }
  return registered;
}

function hasFetchCandidateUrls(snapshot: ResearchSnapshot): boolean {
  if ((snapshot.researchPlans ?? []).at(-1)?.fetchCandidateUrls?.length) return true;
  if ((snapshot.continuationDecisions ?? []).at(-1)?.fetchCandidateUrls?.length) return true;
  for (const source of snapshot.sources ?? []) {
    if (source.kind === "web" && source.url && !source.rawPath && source.metadata.fetchStatus !== "fetched") return true;
  }
  for (const evidence of snapshot.evidence ?? []) {
    if (evidence.sourceUri) return true;
  }
  for (const citation of (snapshot.projectContextSnapshots ?? []).at(-1)?.citations ?? []) {
    if (httpUrlPattern.test(citation)) return true;
  }
  return false;
}

function hasContinuationFetchHint(snapshot: ResearchSnapshot): boolean {
  const decision = (snapshot.continuationDecisions ?? []).at(-1);
  for (const hint of decision?.planRevisionHints ?? []) {
    if (webFetchHintPattern.test(hint)) return true;
  }
  return false;
}

function hasPdfInput(snapshot: ResearchSnapshot): boolean {
  for (const source of snapshot.sources ?? []) {
    if (isPdfInputUrl(source.url ?? String(source.metadata.pdfUrl ?? ""))) return true;
  }
  for (const url of (snapshot.researchPlans ?? []).at(-1)?.fetchCandidateUrls ?? []) {
    if (isPdfInputUrl(url)) return true;
  }
  return false;
}

function hasPolicyPdfInput(sourceAccess: SourceAccessPolicy | undefined): boolean {
  return sourceAccess?.mode === "allowlist" && sourceAccess.urls.some(isPdfInputUrl);
}

const httpUrlPattern = /^https?:\/\//i;
const pdfUrlPattern = /\.pdf($|[?#])/i;
const arxivAbsUrlPattern = /arxiv\.org\/abs\//i;
const arxivPdfUrlPattern = /arxiv\.org\/pdf\//i;
const webFetchHintPattern = /webfetch|fetch selected source|citation-backed evidence/i;

function isPdfInputUrl(value: string): boolean {
  return pdfUrlPattern.test(value) || arxivAbsUrlPattern.test(value) || arxivPdfUrlPattern.test(value);
}
