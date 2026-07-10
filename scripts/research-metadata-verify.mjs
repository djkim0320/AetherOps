let args;
let query;
let maxResults;
let timeoutMs;

try {
  args = parseArgs(process.argv.slice(2));
  query = parseQuery(args.query, "deep learning neural networks");
  maxResults = parsePositiveInt(args.maxResults, process.env.AETHEROPS_METADATA_VERIFY_MAX_RESULTS, 5, "max results");
  timeoutMs = parsePositiveInt(args.timeoutMs, process.env.AETHEROPS_METADATA_VERIFY_TIMEOUT_MS, 30_000, "timeout ms");
} catch (error) {
  console.error("AetherOps research metadata verification: FAIL");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const [{ ResearchMetadataTool }, { defaultSettings }] = await Promise.all([
  import("../dist-server/server/runtime/tools/researchMetadataTool.js"),
  import("../dist-server/server/runtime/storage/settingsStore.js")
]);

const timestamp = new Date().toISOString();
const projectId = "metadata-verify-project";
const input = {
  project: {
    id: projectId,
    goal: query,
    topic: query,
    scope: "Verify real OpenAlex research metadata ingestion with no substitute data.",
    budget: "verify",
    autonomyPolicy: {
      toolApproval: "suggested",
      allowExternalSearch: true,
      allowCodeExecution: false,
      maxLoopIterations: 1
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    currentStep: "EXECUTE_TOOLS",
    status: "running",
    projectRoot: "."
  },
  questions: [
    {
      id: "metadata-verify-question",
      projectId,
      text: query,
      status: "open",
      createdAt: timestamp
    }
  ],
  hypotheses: [
    {
      id: "metadata-verify-hypothesis",
      projectId,
      questionId: "metadata-verify-question",
      statement: `${query} has traceable scholarly metadata in OpenAlex.`,
      status: "untested",
      confidence: 0.5,
      createdAt: timestamp
    }
  ],
  researchPlan: {
    id: "metadata-verify-plan",
    projectId,
    iteration: 1,
    objective: query,
    targetQuestions: [query],
    targetHypotheses: [`${query} has traceable scholarly metadata in OpenAlex.`],
    requiredTools: ["ResearchMetadataTool"],
    expectedSources: ["OpenAlex paper metadata"],
    expectedArtifacts: [],
    executionSteps: ["Run ResearchMetadataTool against the real OpenAlex API."],
    stopCriteria: ["At least one paper source and one citation-backed evidence item are returned."],
    createdAt: timestamp
  },
  iteration: 1
};

const settings = {
  ...defaultSettings,
  allowExternalSearch: true,
  researchMetadata: {
    ...defaultSettings.researchMetadata,
    enabled: true,
    provider: "openalex",
    maxResults,
    timeoutMs
  }
};

try {
  const result = await new ResearchMetadataTool().run(input, settings);
  const providerSources = result.sources.filter((source) => source.metadata?.provider === "openalex");
  const providerSourceIds = new Set(providerSources.map((source) => source.id));
  const providerSourceUris = new Set(providerSources.map((source) => source.url).filter(Boolean));
  const citationEvidence = result.evidence.filter(
    (item) =>
      item.metadata?.provider === "openalex" &&
      item.citation &&
      item.quote &&
      item.sourceId &&
      providerSourceIds.has(item.sourceId) &&
      item.sourceUri &&
      providerSourceUris.has(item.sourceUri)
  );
  const missingDoiOrUrl = providerSources.filter((source) => !source.doi && !source.url);
  if (result.toolRun.status !== "completed") {
    throw new Error(`ResearchMetadataTool did not complete: ${result.toolRun.error ?? JSON.stringify(result.toolRun.output)}`);
  }
  if (!providerSources.length) {
    throw new Error("ResearchMetadataTool returned no OpenAlex paper sources.");
  }
  if (!citationEvidence.length) {
    throw new Error("ResearchMetadataTool returned no OpenAlex citation-backed evidence with quote text linked to a returned OpenAlex source.");
  }
  if (missingDoiOrUrl.length) {
    throw new Error("ResearchMetadataTool returned a paper source without DOI or URL.");
  }
  const output = {
    status: "PASS",
    query,
    sourceCount: result.sources.length,
    evidenceCount: result.evidence.length,
    firstSource: {
      title: providerSources[0]?.title,
      doi: providerSources[0]?.doi,
      url: providerSources[0]?.url,
      citedByCount: providerSources[0]?.metadata?.citedByCount
    },
    firstEvidence: {
      title: citationEvidence[0]?.title,
      citation: citationEvidence[0]?.citation,
      quoteLength: citationEvidence[0]?.quote?.length ?? 0
    }
  };
  console.log("AetherOps research metadata verification: PASS");
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error("AetherOps research metadata verification: FAIL");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--query") {
      parsed.query = readOptionValue(values, index, "--query");
      index += 1;
    } else if (value?.startsWith("--query=")) {
      parsed.query = value.slice("--query=".length);
    } else if (value === "--max-results") {
      parsed.maxResults = readOptionValue(values, index, "--max-results");
      index += 1;
    } else if (value?.startsWith("--max-results=")) {
      parsed.maxResults = value.slice("--max-results=".length);
    } else if (value === "--timeout-ms") {
      parsed.timeoutMs = readOptionValue(values, index, "--timeout-ms");
      index += 1;
    } else if (value?.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = value.slice("--timeout-ms=".length);
    } else if (value) {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function readOptionValue(values, index, optionName) {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function parseQuery(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const trimmed = value.trim();
  if (!trimmed) throw new Error("metadata verify query must be a non-empty string.");
  return trimmed;
}

function parsePositiveInt(argValue, envValue, defaultValue, label) {
  const value = argValue ?? envValue;
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`metadata verify ${label} must be a positive integer.`);
  }
  return parsed;
}
