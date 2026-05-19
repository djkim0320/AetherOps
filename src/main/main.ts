import { app, BrowserWindow, Menu } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CompositeOpenCodeAdapter } from "../core/compositeOpenCodeAdapter.js";
import { ApiEmbeddingProvider } from "../core/embeddingProvider.js";
import { LocalResearchAdapter } from "../core/localResearchAdapter.js";
import { MockOpenCodeAdapter } from "../core/mockOpenCodeAdapter.js";
import { AetherOpsOrchestrator } from "../core/orchestrator.js";
import { VectorRagEngine } from "../core/vectorRagEngine.js";
import { CodexOAuthLlmProvider } from "./codexOAuthLlmProvider.js";
import { registerAetherOpsIpc } from "./ipc.js";
import { NodeProjectStorage } from "./projectResearchStore.js";
import { RealOpenCodeAdapter } from "./realOpenCodeAdapter.js";
import { JsonAppSettingsStore } from "./settingsStore.js";
import { SqliteResearchStore } from "./sqliteStore.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const appRoot = app.isPackaged ? app.getAppPath() : process.cwd();
const aetherRoot = process.env.AETHEROPS_DATA_DIR ?? join(app.getPath("userData"), ".aetherops");
mkdirSync(aetherRoot, { recursive: true });
console.log(`[AetherOps] storage root: ${aetherRoot}`);

const store = new SqliteResearchStore(join(aetherRoot, "aetherops.sqlite"));
const settingsStore = new JsonAppSettingsStore(join(aetherRoot, "settings.json"));
const llm = new CodexOAuthLlmProvider({
  cwd: aetherRoot,
  model: async () => {
    const runtimeSettings = await settingsStore.getRuntimeSettings();
    return runtimeSettings.openCodeLlm.source === "codex-oauth" ? runtimeSettings.openCodeLlm.model : undefined;
  }
});
const settings = () => settingsStore.getRuntimeSettings();
const embeddingProvider = {
  embed: async (text: string) => new ApiEmbeddingProvider((await settings()).embedding).embed(text)
};
const openCode = new CompositeOpenCodeAdapter([
  new RealOpenCodeAdapter(settings),
  new LocalResearchAdapter(settings, llm),
  new MockOpenCodeAdapter(settings)
]);
const projectStorage = new NodeProjectStorage();
const orchestrator = new AetherOpsOrchestrator(
  store,
  openCode,
  new VectorRagEngine(embeddingProvider),
  join(aetherRoot, "projects"),
  llm,
  projectStorage,
  embeddingProvider
);
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
      nodeIntegration: false,
      sandbox: false
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
