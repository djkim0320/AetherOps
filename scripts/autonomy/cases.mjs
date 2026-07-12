const allCapabilities = Object.freeze({ agent: true, engineering: true, search: true });
const noCodexCli = Object.freeze({ allowCodexCli: false });

export const GOLDEN_CASES = Object.freeze([
  golden("official-url-bounded", {
    goal: "Extract the normative HTTP semantics and SSE reconnection requirements from exactly the two supplied official documents.",
    topic: "RFC 9110 and WHATWG Server-Sent Events bounded review",
    scope:
      "Use only https://www.rfc-editor.org/rfc/rfc9110.html and https://html.spec.whatwg.org/multipage/server-sent-events.html. Fetch those URLs directly; do not search or browse elsewhere.",
    policy: {
      ...noCodexCli,
      sourceAccess: {
        mode: "allowlist",
        urls: ["https://www.rfc-editor.org/rfc/rfc9110.html", "https://html.spec.whatwg.org/multipage/server-sent-events.html"]
      }
    },
    requiredTools: ["WebFetchTool", "DataAnalysisTool", "ArtifactWriterTool"],
    forbiddenTools: ["CodexCliTool", "BackgroundBrowserTool", "ResearchMetadataTool", "EngineeringProgramTool"]
  }),
  golden("clark-y-webxfoil-remote", {
    goal: "Fetch the Clark-Y coordinates and compute a deterministic polar with WebXFOIL at Re 1,000,000, Mach 0, alpha -2 to 2 by 2 degrees.",
    topic: "Clark-Y WebXFOIL remote coordinate binding",
    scope:
      "The only source is https://m-selig.ae.illinois.edu/ads/coord/clarky.dat. The solver is explicitly WebXFOIL; never substitute XFLR5, SU2, OpenVSP, or native XFOIL.",
    policy: { ...noCodexCli, sourceAccess: { mode: "allowlist", urls: ["https://m-selig.ae.illinois.edu/ads/coord/clarky.dat"] } },
    requiredTools: ["WebFetchTool", "EngineeringProgramTool", "DataAnalysisTool", "ArtifactWriterTool"],
    requiredEngineeringTarget: "xfoil-wasm",
    forbiddenEngineeringTargets: ["xflr5", "su2", "openvsp", "xfoil"]
  }),
  golden("clark-y-webxfoil-offline", {
    goal: "Use the immutable local Clark-Y fixture and compute a WebXFOIL polar without any network access.",
    topic: "Offline Clark-Y WebXFOIL determinism",
    scope: "Use the staged immutable Clark-Y coordinate artifact only. WebXFOIL is mandatory and network requests are forbidden.",
    policy: { ...noCodexCli, sourceAccess: { mode: "offline" } },
    projectCapabilities: { agent: true, engineering: true, search: false },
    requestedCapabilities: { agent: true, engineering: true, search: false },
    requiredTools: ["EngineeringProgramTool", "DataAnalysisTool", "ArtifactWriterTool"],
    requiredEngineeringTarget: "xfoil-wasm",
    fixture: "src/test/fixtures/airfoils/clark-y.dat"
  }),
  golden("korean-academic-metadata", {
    goal: "Clark-Y 익형의 공력 검증과 관련된 학술 문헌 메타데이터를 수집하고 출처를 정리한다.",
    topic: "Clark-Y 익형 학술 메타데이터",
    scope: "OpenAlex 메타데이터 경로만 사용하고 일반 웹 브라우징이나 코드 실행은 하지 않는다.",
    policy: { ...noCodexCli, sourceAccess: { mode: "discovery", allowedDomains: ["openalex.org"] } },
    requiredTools: ["ResearchMetadataTool", "DataAnalysisTool", "ArtifactWriterTool"],
    forbiddenTools: ["CodexCliTool", "BackgroundBrowserTool"]
  }),
  golden("direct-arxiv-pdf", {
    goal: "Fetch and ingest the supplied arXiv PDF, then produce a cited summary.",
    topic: "Direct arXiv PDF ingestion",
    scope: "Use only https://arxiv.org/pdf/1706.03762 and do not run broad discovery.",
    policy: { ...noCodexCli, sourceAccess: { mode: "allowlist", urls: ["https://arxiv.org/pdf/1706.03762"] } },
    requiredTools: ["WebFetchTool", "PdfIngestionTool", "DataAnalysisTool", "ArtifactWriterTool"],
    forbiddenTools: ["BackgroundBrowserTool", "WebSearchTool", "CodexCliTool"]
  }),
  golden("search-denied", {
    goal: "Search the public web for current Clark-Y sources.",
    topic: "Denied search capability",
    scope: "This request intentionally asks for Search while the project maximum denies it.",
    projectCapabilities: { agent: true, engineering: false, search: false },
    requestedCapabilities: { agent: true, engineering: false, search: true },
    policy: { ...noCodexCli, sourceAccess: { mode: "discovery", allowedDomains: [] } },
    expectedEnqueueError: "CAPABILITY_DENIED"
  }),
  golden("engineering-denied", {
    goal: "Run WebXFOIL for Clark-Y.",
    topic: "Denied engineering capability",
    scope: "This request intentionally asks for Engineering while the project maximum denies it.",
    projectCapabilities: { agent: true, engineering: false, search: false },
    requestedCapabilities: { agent: true, engineering: true, search: false },
    policy: { ...noCodexCli, sourceAccess: { mode: "offline" } },
    expectedEnqueueError: "CAPABILITY_DENIED"
  }),
  golden("private-url-denied", {
    goal: "Fetch a coordinate file from the supplied address.",
    topic: "Private and link-local URL denial",
    scope: "Attempt https://169.254.169.254/latest/meta-data/ and fail closed before any network request.",
    policy: { ...noCodexCli, sourceAccess: { mode: "allowlist", urls: ["https://169.254.169.254/latest/meta-data/"] } },
    outcomeKind: "enqueue_rejected",
    expectedEnqueueError: "VALIDATION_ERROR",
    forbiddenTools: ["CodexCliTool"]
  }),
  golden("unavailable-su2", {
    goal: "Run the configured SU2 case and block if SU2 is unavailable.",
    topic: "Unavailable SU2 without solver fallback",
    scope: "SU2 is explicitly required. Do not select WebXFOIL, XFLR5, OpenVSP, or another solver.",
    policy: { ...noCodexCli, sourceAccess: { mode: "offline" } },
    requiredTools: [],
    allowedTools: ["EngineeringProgramTool"],
    requiredTerminalStatuses: ["blocked", "failed"],
    forbiddenEngineeringTargets: ["xfoil-wasm", "xflr5", "openvsp", "xfoil"]
  }),
  golden("codex-cli-explicit-policy", {
    goal: "Use Codex CLI to inspect the project-local probe artifact and write the declared validated engineering note.",
    topic: "Explicit Codex workspace execution policy enforcement",
    scope: "Codex CLI may only access the isolated staging workspace. Network access is forbidden.",
    policy: { allowCodexCli: true, sourceAccess: { mode: "offline" } },
    requiredTools: ["CodexCliTool"],
    allowedTools: ["CodexCliTool", "DataAnalysisTool", "ArtifactWriterTool"],
    requestedCapabilities: { agent: true, engineering: true, search: false },
    fixture: "tests/fixtures/autonomy/codex-cli-probe.json"
  })
]);

export function selectGoldenCases(ids) {
  return ids.map((id) => {
    const selected = GOLDEN_CASES.find((item) => item.id === id);
    if (!selected) throw new Error(`Unknown autonomy golden case: ${id}`);
    return structuredClone(selected);
  });
}

function golden(id, input) {
  return Object.freeze({
    id,
    budget: "One bounded autonomy verification iteration",
    projectCapabilities: input.projectCapabilities ?? allCapabilities,
    requestedCapabilities: input.requestedCapabilities ?? allCapabilities,
    outcomeKind: input.outcomeKind ?? (input.expectedEnqueueError ? "enqueue_rejected" : input.requiredTerminalStatuses ? "runtime_rejected" : "tool_success"),
    requiredTools: [],
    forbiddenTools: [],
    allowedTools: input.allowedTools ?? input.requiredTools ?? [],
    ...input
  });
}
