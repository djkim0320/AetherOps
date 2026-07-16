export function printDoctorResult(result) {
  const lines = [
    "AetherOps Doctor",
    "================",
    `Node.js: ${result.nodeVersion} (${result.engine})`,
    `npm: ${result.npmVersion || "unknown"}`,
    `Data root: ${result.dataRoot}`,
    `Server port: ${result.port} (${result.portStatus ?? (result.portAvailable ? "available" : "occupied")})`,
    `Settings: ${result.settings}`,
    `Codex orchestrator: ${result.codex}`,
    `Codex CLI sandbox: ${result.codexSandboxStatus} (${result.codexSandboxMode})`,
    `Embedding: ${result.embedding}`,
    `Web Search: ${result.search}`,
    `Engineering programs: ${result.engineering} (${result.engineeringTargets.join(", ") || "none"})`,
    `SQLite FTS5: ${result.fts5}`,
    `Canonical API-only source: ${result.canonicalApiOnly ? "pass" : "fail"}`,
    `Codex-only orchestrator source: ${result.codexOnlySource ? "pass" : "fail"}`,
    `Production substitute adapters: ${result.productionSubstituteAdapters}`,
    `Offline ready: ${result.offlineReady}`,
    `Live ready: ${result.liveReady}`
  ];
  if (!result.liveReady) lines.push("LIVE_TEST_NOT_READY");
  if (result.recommendations.length) {
    lines.push("", "Recommended next actions:");
    for (const item of result.recommendations) lines.push(`- ${item}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}
