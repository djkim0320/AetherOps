import type { AetherOpsApi } from "../vite-env.js";

const missingApiMessage =
  "AetherOps 백엔드에 연결하지 못했습니다. `npm run dev` 또는 `npm run start`를 실행해 주세요.";
const configuredHttpApiBaseUrl = import.meta.env.VITE_AETHEROPS_API_URL;
const httpApiBaseUrl = configuredHttpApiBaseUrl
  ? configuredHttpApiBaseUrl.replace(/\/$/, "")
  : window.location.port === "5180"
    ? "http://127.0.0.1:5179"
    : window.location.origin;

export function isAetherOpsApiAvailable(): boolean {
  return typeof window.fetch === "function";
}

export async function waitForAetherOpsApi(timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`${httpApiBaseUrl}/api/health`, { cache: "no-store" });
      if (response.ok) {
        return true;
      }
    } catch {
      // Retry below after the same delay used for non-OK health responses.
    }
    await sleep(100);
  }
  return false;
}

export function getAetherOpsApi(): AetherOpsApi {
  return {
    projects: {
      create: (input) => rpc("projects.create", input),
      update: (projectId, input) => rpc("projects.update", projectId, input),
      list: () => rpc("projects.list")
    },
    sessions: {
      createForProject: (projectId) => rpc("sessions.createForProject", projectId),
      create: (projectId, title, focus) => rpc("sessions.create", projectId, title, focus),
      delete: (projectId, sessionId) => rpc("sessions.delete", projectId, sessionId)
    },
    chat: {
      send: (projectId, sessionId, content) => rpc("chat.send", projectId, sessionId, content)
    },
    researchDb: {
      create: (projectId) => rpc("researchDb.create", projectId)
    },
    research: {
      seedQuestions: (projectId) => rpc("research.seedQuestions", projectId),
      inputResearchQuestionHypothesis: (projectId, payload) => rpc("research.inputResearchQuestionHypothesis", projectId, payload),
      buildSpecification: (projectId) => rpc("research.buildSpecification", projectId),
      plan: (projectId) => rpc("research.plan", projectId)
    },
    loop: {
      start: (projectId) => rpc("loop.start", projectId),
      pause: (projectId) => rpc("loop.pause", projectId),
      resume: (projectId) => rpc("loop.resume", projectId),
      abort: (projectId) => rpc("loop.abort", projectId)
    },
    opencode: {
      authLogin: (provider) => rpc("opencode.authLogin", provider),
      authList: () => rpc("opencode.authList")
    },
    artifacts: {
      store: (projectId, artifact) => rpc("artifacts.store", projectId, artifact)
    },
    llm: {
      status: () => rpc("llm.status")
    },
    settings: {
      get: () => rpc("settings.get"),
      save: (settings) => rpc("settings.save", settings)
    },
    tools: {
      diagnostics: () => rpc("tools.diagnostics"),
      preflightEngineering: (target) => rpc("tools.preflightEngineering", target)
    },
    snapshots: {
      get: (projectId) => rpc("snapshots.get", projectId)
    },
    events: {
      onLoopIteration: () => () => undefined
    }
  };
}

export function getMissingAetherOpsApiMessage(): string {
  return missingApiMessage;
}

async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`${httpApiBaseUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ method, args })
  });
  const payload = (await response.json()) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || missingApiMessage);
  }
  return payload.result as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
