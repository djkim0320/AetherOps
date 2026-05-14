import { BrowserWindow, ipcMain } from "electron";
import type { AetherOpsOrchestrator } from "../core/orchestrator.js";
import type { AppSettings, CreateProjectInput, ResearchArtifact } from "../core/types.js";
import type { AppSettingsStore } from "./settingsStore.js";

export function registerAetherOpsIpc(orchestrator: AetherOpsOrchestrator, settingsStore: AppSettingsStore): void {
  ipcMain.handle("projects.create", async (_event, input: CreateProjectInput) => orchestrator.createProject(input));
  ipcMain.handle("projects.list", async () => orchestrator.listProjects());
  ipcMain.handle("sessions.createForProject", async (_event, projectId: string) => {
    const snapshot = await orchestrator.createSubSessions(projectId);
    return snapshot.sessions;
  });
  ipcMain.handle("researchDb.create", async (_event, projectId: string) => orchestrator.createResearchDb(projectId));
  ipcMain.handle("research.seedQuestions", async (_event, projectId: string) => orchestrator.seedQuestions(projectId));
  ipcMain.handle("loop.start", async (_event, projectId: string) => orchestrator.startLoop(projectId));
  ipcMain.handle("loop.pause", async (_event, projectId: string) => orchestrator.pause(projectId));
  ipcMain.handle("loop.resume", async (_event, projectId: string) => orchestrator.resume(projectId));
  ipcMain.handle("loop.abort", async (_event, projectId: string) => orchestrator.abort(projectId));
  ipcMain.handle("opencode.run", async (_event, projectId: string) => orchestrator.runOpenCode(projectId));
  ipcMain.handle("artifacts.store", async (_event, projectId: string, artifact: Partial<ResearchArtifact>) =>
    orchestrator.storeArtifact(projectId, artifact)
  );
  ipcMain.handle("rag.buildContext", async (_event, projectId: string) => orchestrator.buildRagContext(projectId));
  ipcMain.handle("results.derive", async (_event, projectId: string) => orchestrator.deriveResult(projectId));
  ipcMain.handle("reports.finalize", async (_event, projectId: string) => orchestrator.finalizeReport(projectId));
  ipcMain.handle("llm.status", async () => orchestrator.getLlmStatus());
  ipcMain.handle("settings.get", async () => settingsStore.getSettings());
  ipcMain.handle("settings.save", async (_event, settings: AppSettings) => settingsStore.saveSettings(settings));
  ipcMain.handle("snapshots.get", async (_event, projectId: string) => orchestrator.getSnapshot(projectId));
}

export function broadcastLoopIteration(payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("loop.iteration", payload);
  }
}
