const LIVE_RUNTIME = Object.freeze({ model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 180_000, taskTimeoutMs: 600_000 });

export const AUTONOMY_PROFILES = Object.freeze({
  offline: Object.freeze({ name: "offline", live: false, repetitions: 1, concurrency: 1, caseIds: [] }),
  smoke: Object.freeze({
    name: "smoke",
    live: true,
    repetitions: 1,
    concurrency: 1,
    caseIds: ["official-url-bounded", "clark-y-webxfoil-remote", "search-denied", "private-url-denied", "codex-cli-explicit-policy"]
  }),
  nightly: Object.freeze({
    name: "nightly",
    live: true,
    repetitions: 3,
    concurrency: 2,
    caseIds: [
      "official-url-bounded",
      "clark-y-webxfoil-remote",
      "clark-y-webxfoil-offline",
      "korean-academic-metadata",
      "direct-arxiv-pdf",
      "search-denied",
      "engineering-denied",
      "private-url-denied",
      "unavailable-su2"
    ]
  }),
  release: Object.freeze({
    name: "release",
    live: true,
    repetitions: 5,
    concurrency: 2,
    caseIds: [
      "official-url-bounded",
      "clark-y-webxfoil-remote",
      "clark-y-webxfoil-offline",
      "korean-academic-metadata",
      "direct-arxiv-pdf",
      "search-denied",
      "engineering-denied",
      "private-url-denied",
      "unavailable-su2",
      "codex-cli-explicit-policy"
    ]
  })
});

export function getAutonomyProfile(name) {
  return AUTONOMY_PROFILES[name];
}

export function requiredLiveRuntime() {
  return { ...LIVE_RUNTIME };
}

export function assertExactLiveRuntime(settings) {
  const actual = settings?.codex ?? settings;
  const differences = Object.entries(LIVE_RUNTIME)
    .filter(([key, expected]) => actual?.[key] !== expected)
    .map(([key, expected]) => `${key}: expected ${expected}, received ${String(actual?.[key])}`);
  if (differences.length) throw new Error(`Live autonomy runtime mismatch: ${differences.join("; ")}`);
  return true;
}
