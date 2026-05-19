import type { AetherOpsApi } from "../vite-env.js";

const missingApiMessage =
  "AetherOps Electron API가 연결되지 않았습니다. run-aetherops.bat 또는 AetherOps.vbs로 실행해 주세요. 브라우저/Vite 화면에서는 연구 데이터가 저장되지 않습니다.";

export function isAetherOpsApiAvailable(): boolean {
  return Boolean(window.aetherOps);
}

export async function waitForAetherOpsApi(timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (isAetherOpsApiAvailable()) {
      return true;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  return isAetherOpsApiAvailable();
}

export function getAetherOpsApi(): AetherOpsApi {
  return {
    projects: {
      create: (input) => call((api) => api.projects.create(input)),
      list: () => call((api) => api.projects.list())
    },
    sessions: {
      createForProject: (projectId) => call((api) => api.sessions.createForProject(projectId)),
      create: (projectId, title, focus) => call((api) => api.sessions.create(projectId, title, focus)),
      delete: (projectId, sessionId) => call((api) => api.sessions.delete(projectId, sessionId))
    },
    chat: {
      send: (projectId, sessionId, content) => call((api) => api.chat.send(projectId, sessionId, content))
    },
    researchDb: {
      create: (projectId) => call((api) => api.researchDb.create(projectId))
    },
    research: {
      seedQuestions: (projectId) => call((api) => api.research.seedQuestions(projectId))
    },
    loop: {
      start: (projectId) => call((api) => api.loop.start(projectId)),
      pause: (projectId) => call((api) => api.loop.pause(projectId)),
      resume: (projectId) => call((api) => api.loop.resume(projectId)),
      abort: (projectId) => call((api) => api.loop.abort(projectId))
    },
    opencode: {
      run: (projectId) => call((api) => api.opencode.run(projectId)),
      authLogin: (provider) => call((api) => api.opencode.authLogin(provider)),
      authList: () => call((api) => api.opencode.authList())
    },
    artifacts: {
      store: (projectId, artifact) => call((api) => api.artifacts.store(projectId, artifact))
    },
    rag: {
      buildContext: (projectId) => call((api) => api.rag.buildContext(projectId))
    },
    results: {
      derive: (projectId) => call((api) => api.results.derive(projectId))
    },
    reports: {
      finalize: (projectId) => call((api) => api.reports.finalize(projectId))
    },
    llm: {
      status: () => call((api) => api.llm.status())
    },
    settings: {
      get: () => call((api) => api.settings.get()),
      save: (settings) => call((api) => api.settings.save(settings))
    },
    snapshots: {
      get: (projectId) => call((api) => api.snapshots.get(projectId))
    },
    events: {
      onLoopIteration: (callback) => requireAetherOpsApi().events.onLoopIteration(callback)
    }
  };
}

export function getMissingAetherOpsApiMessage(): string {
  return missingApiMessage;
}

function requireAetherOpsApi(): AetherOpsApi {
  if (!window.aetherOps) {
    throw new Error(missingApiMessage);
  }
  return window.aetherOps;
}

function call<T>(operation: (api: AetherOpsApi) => Promise<T>): Promise<T> {
  try {
    return operation(requireAetherOpsApi());
  } catch (error) {
    return Promise.reject(error);
  }
}
