import type { EvidenceItem, EvidenceStrength, ResearchSource } from "../shared/types.js";

export type SourceQualityTier = "scholarly" | "public_authority" | "standard" | "education" | "credible_web" | "general_web" | "weak" | "excluded";

export interface SourceQualityAssessment {
  tier: SourceQualityTier;
  label: string;
  reliabilityScore: number;
  evidenceStrength: EvidenceStrength;
  canSupportHypothesis: boolean;
  preferredForSearch: boolean;
  limitations: string[];
}

const SEARCH_HOSTS = ["google.com", "google.co.kr", "scholar.google.com", "duckduckgo.com", "bing.com", "search.brave.com", "brave.com", "microsoft.com"];

const SCHOLARLY_HOSTS = [
  "semanticscholar.org",
  "arxiv.org",
  "doi.org",
  "crossref.org",
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  "acm.org",
  "ieee.org",
  "springer.com",
  "sciencedirect.com",
  "nature.com",
  "plos.org",
  "frontiersin.org",
  "mdpi.com",
  "tandfonline.com",
  "jstor.org",
  "ssrn.com"
];

const PUBLIC_AUTHORITY_HOSTS = [
  "nist.gov",
  "data.gov",
  "gov.uk",
  "europa.eu",
  "oecd.org",
  "worldbank.org",
  "who.int",
  "un.org",
  "go.kr",
  "korea.kr",
  "kdi.re.kr"
];

const STANDARD_HOSTS = ["iso.org", "w3.org", "ietf.org", "rfc-editor.org", "nvlpubs.nist.gov"];
const WEAK_HOSTS = ["wikipedia.org", "namu.wiki", "fandom.com", "medium.com", "blogspot.com", "tistory.com", "reddit.com", "quora.com"];
const SEMANTIC_SCHOLAR_HOSTS = ["semanticscholar.org"];
const CROSSREF_HOSTS = ["crossref.org"];
const ARXIV_HOSTS = ["arxiv.org"];
const DOI_CITATION_PATTERN = /10\.\d{4,9}\//;
const PAPER_URL_PATTERN = /(\barxiv\b|\bdoi\b|\/pdf\/|\.pdf\b|journal|proceedings|conference|working paper|systematic review)/i;
const TIER_RANK: Record<SourceQualityTier, number> = {
  scholarly: 90,
  public_authority: 86,
  standard: 84,
  education: 76,
  credible_web: 62,
  general_web: 40,
  weak: 10,
  excluded: -100
};

export function assessSourceQuality(rawUrl?: string, title?: string): SourceQualityAssessment {
  const hostname = hostnameOf(rawUrl);
  if (!hostname) {
    return quality("general_web", "Unclassified source", 0.45, "weak", false, false, ["No URL or DOI-like source identifier was available."]);
  }

  if (isDiscoverySurface(rawUrl, hostname)) {
    return quality("excluded", "Search/discovery page", 0.2, "weak", false, false, [
      "Search and discovery pages can help find sources but should not be cited as evidence."
    ]);
  }

  if (matchesHost(hostname, SEARCH_HOSTS)) {
    return quality("excluded", "Search result page", 0.2, "weak", false, false, ["Search result pages are discovery surfaces, not citable evidence."]);
  }

  if (matchesHost(hostname, WEAK_HOSTS)) {
    return quality("weak", "Weak tertiary/community source", 0.35, "weak", false, false, [
      "Use only as background context unless corroborated by scholarly, public, or standards sources."
    ]);
  }

  if (matchesHost(hostname, SCHOLARLY_HOSTS) || looksLikePaperUrl(rawUrl, title)) {
    return quality("scholarly", "Scholarly or paper source", 0.86, "strong", true, true, []);
  }

  if (matchesHost(hostname, STANDARD_HOSTS)) {
    return quality("standard", "Standards or specification source", 0.9, "strong", true, true, []);
  }

  if (matchesHost(hostname, PUBLIC_AUTHORITY_HOSTS) || hostname.endsWith(".gov") || hostname.endsWith(".gov.kr")) {
    return quality("public_authority", "Public authority source", 0.88, "strong", true, true, []);
  }

  if (hostname.endsWith(".edu") || hostname.endsWith(".ac.kr")) {
    return quality("education", "Academic institution source", 0.78, "medium", true, true, [
      "Institutional pages should still be checked for authorship and publication context."
    ]);
  }

  if (hostname.endsWith(".org")) {
    return quality("credible_web", "Organization web source", 0.62, "medium", true, false, [
      "Organization web pages are weaker than papers, public datasets, or standards."
    ]);
  }

  return quality("general_web", "General web source", 0.5, "weak", false, false, [
    "General web pages should not support hypotheses unless corroborated by stronger sources."
  ]);
}

function isDiscoverySurface(rawUrl: string | undefined, hostname: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();
    return (
      (matchesHost(hostname, SEMANTIC_SCHOLAR_HOSTS) && path.startsWith("/search")) ||
      (matchesHost(hostname, CROSSREF_HOSTS) && (hostname.startsWith("search.") || path.startsWith("/search"))) ||
      (matchesHost(hostname, ARXIV_HOSTS) && path.startsWith("/search"))
    );
  } catch {
    return false;
  }
}

export function rankResearchUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const ranked: Array<{ url: string; index: number; quality: SourceQualityAssessment }> = [];
  let uniqueIndex = 0;
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const quality = assessSourceQuality(url);
    if (quality.tier !== "excluded") {
      ranked.push({ url, index: uniqueIndex, quality });
    }
    uniqueIndex += 1;
  }
  ranked.sort((a, b) => sourceRank(b.quality) - sourceRank(a.quality) || a.index - b.index);
  const output: string[] = [];
  for (const item of ranked) output.push(item.url);
  return output;
}

export function canEvidenceSupportHypothesis(evidence: EvidenceItem, source?: ResearchSource): boolean {
  const quality = assessSourceQuality(evidence.sourceUri ?? source?.url ?? source?.rawPath, evidence.title);
  if (quality.tier === "weak" || quality.tier === "excluded") {
    return false;
  }
  if (evidence.doi || DOI_CITATION_PATTERN.test(evidence.citation ?? "")) {
    return true;
  }
  if (quality.canSupportHypothesis) {
    return true;
  }
  return (evidence.reliabilityScore ?? 0) >= 0.7 && (evidence.evidenceStrength === "strong" || (evidence.relevanceScore ?? 0) >= 0.7);
}

export function sourceQualityMetadata(rawUrl?: string, title?: string): Record<string, unknown> {
  const assessment = assessSourceQuality(rawUrl, title);
  return {
    sourceQualityTier: assessment.tier,
    sourceQualityLabel: assessment.label,
    sourceQualityScore: assessment.reliabilityScore,
    preferredForSearch: assessment.preferredForSearch,
    sourceCanSupportHypothesis: assessment.canSupportHypothesis
  };
}

function quality(
  tier: SourceQualityTier,
  label: string,
  reliabilityScore: number,
  evidenceStrength: EvidenceStrength,
  canSupportHypothesis: boolean,
  preferredForSearch: boolean,
  limitations: string[]
): SourceQualityAssessment {
  return { tier, label, reliabilityScore, evidenceStrength, canSupportHypothesis, preferredForSearch, limitations };
}

function sourceRank(assessment: SourceQualityAssessment): number {
  return TIER_RANK[assessment.tier] + assessment.reliabilityScore;
}

function hostnameOf(rawUrl?: string): string {
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matchesHost(hostname: string, domains: string[]): boolean {
  for (const domain of domains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function looksLikePaperUrl(rawUrl?: string, title?: string): boolean {
  const value = `${rawUrl ?? ""} ${title ?? ""}`.toLowerCase();
  return PAPER_URL_PATTERN.test(value);
}
