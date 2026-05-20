import type { AetherOpsApi } from "../vite-env.js";

const missingApiMessage =
  "AetherOps 웹 백엔드가 연결되지 않았습니다. `npm run dev`로 웹앱을 실행하거나, 빌드 후 `npm run start`를 실행해 주세요.";

export function isAetherOpsApiAvailable(): boolean {
  return typeof window.fetch === "function";
}

export async function waitForAetherOpsApi(timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`${getHttpApiBaseUrl()}/api/health`, { cache: "no-store" });
      if (response.ok) {
        return true;
      }
    } catch {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
  }
  return false;
}

export function getAetherOpsApi(): AetherOpsApi {
  return {
    projects: {
      create: (input) => rpc("projects.create", input),
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
      inputResearchQuestionHypothesis: (projectId) => rpc("research.inputResearchQuestionHypothesis", projectId),
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
      run: (projectId) => rpc("opencode.run", projectId),
      authLogin: (provider) => rpc("opencode.authLogin", provider),
      authList: () => rpc("opencode.authList")
    },
    artifacts: {
      store: (projectId, artifact) => rpc("artifacts.store", projectId, artifact)
    },
    rag: {
      buildContext: (projectId) => rpc("rag.buildContext", projectId)
    },
    results: {
      derive: (projectId) => rpc("results.derive", projectId)
    },
    reports: {
      finalize: (projectId) => rpc("reports.finalize", projectId)
    },
    llm: {
      status: () => rpc("llm.status")
    },
    settings: {
      get: () => rpc("settings.get"),
      save: (settings) => rpc("settings.save", settings)
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
  const response = await fetch(`${getHttpApiBaseUrl()}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args })
  });
  const payload = (await response.json()) as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || missingApiMessage);
  }
  return payload.result as T;
}

function getHttpApiBaseUrl(): string {
  const configured = import.meta.env.VITE_AETHEROPS_API_URL;
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  if (window.location.port === "5180") {
    return "http://127.0.0.1:5179";
  }
  return window.location.origin;
}
