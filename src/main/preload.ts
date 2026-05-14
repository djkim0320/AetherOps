import { contextBridge, ipcRenderer } from "electron";
import type { AetherOpsApi } from "../vite-env.js";

const api: AetherOpsApi = {
  projects: {
    create: (input) => ipcRenderer.invoke("projects.create", input),
    list: () => ipcRenderer.invoke("projects.list")
  },
  sessions: {
    createForProject: (projectId) => ipcRenderer.invoke("sessions.createForProject", projectId)
  },
  researchDb: {
    create: (projectId) => ipcRenderer.invoke("researchDb.create", projectId)
  },
  research: {
    seedQuestions: (projectId) => ipcRenderer.invoke("research.seedQuestions", projectId)
  },
  loop: {
    start: (projectId) => ipcRenderer.invoke("loop.start", projectId),
    pause: (projectId) => ipcRenderer.invoke("loop.pause", projectId),
    resume: (projectId) => ipcRenderer.invoke("loop.resume", projectId),
    abort: (projectId) => ipcRenderer.invoke("loop.abort", projectId)
  },
  opencode: {
    run: (projectId) => ipcRenderer.invoke("opencode.run", projectId)
  },
  artifacts: {
    store: (projectId, artifact) => ipcRenderer.invoke("artifacts.store", projectId, artifact)
  },
  rag: {
    buildContext: (projectId) => ipcRenderer.invoke("rag.buildContext", projectId)
  },
  results: {
    derive: (projectId) => ipcRenderer.invoke("results.derive", projectId)
  },
  reports: {
    finalize: (projectId) => ipcRenderer.invoke("reports.finalize", projectId)
  },
  llm: {
    status: () => ipcRenderer.invoke("llm.status")
  },
  settings: {
    get: () => ipcRenderer.invoke("settings.get"),
    save: (settings) => ipcRenderer.invoke("settings.save", settings)
  },
  snapshots: {
    get: (projectId) => ipcRenderer.invoke("snapshots.get", projectId)
  },
  events: {
    onLoopIteration: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, iteration: unknown) => callback(iteration as never);
      ipcRenderer.on("loop.iteration", listener);
      return () => ipcRenderer.off("loop.iteration", listener);
    }
  }
};

contextBridge.exposeInMainWorld("aetherOps", api);
