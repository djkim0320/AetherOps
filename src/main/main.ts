import { app, BrowserWindow, Menu } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockOpenCodeAdapter } from "../core/mockOpenCodeAdapter.js";
import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import { CodexOAuthLlmProvider } from "./codexOAuthLlmProvider.js";
import { registerAetherOpsIpc } from "./ipc.js";
import { JsonAppSettingsStore } from "./settingsStore.js";
import { SqliteResearchStore } from "./sqliteStore.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const appRoot = app.isPackaged ? app.getAppPath() : process.cwd();
const dataRoot = app.isPackaged ? app.getPath("userData") : process.cwd();
const aetherRoot = join(dataRoot, ".aetherops");
mkdirSync(aetherRoot, { recursive: true });

const store = new SqliteResearchStore(join(aetherRoot, "aetherops.sqlite"));
const settingsStore = new JsonAppSettingsStore(join(aetherRoot, "settings.json"));
const llm = new CodexOAuthLlmProvider({ cwd: dataRoot });
const openCode = new MockOpenCodeAdapter(() => settingsStore.getRuntimeSettings());
const orchestrator = new AetherOpsOrchestrator(store, openCode, undefined, join(aetherRoot, "projects"), llm);
registerAetherOpsIpc(orchestrator, settingsStore);

async function createWindow(): Promise<void> {
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: "AetherOps",
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged && process.env.NODE_ENV !== "production") {
    await window.loadURL("http://127.0.0.1:5180");
  } else {
    await window.loadFile(join(appRoot, "dist/index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", () => {
  llm.dispose();
  store.close();
});
