import { chromium } from "playwright";

const args = parseArgs(process.argv.slice(2));
const appUrl = normalizeUrl(args.url ?? process.env.AETHEROPS_UI_URL ?? "http://127.0.0.1:5180");

const viewportCases = Object.freeze([
  { label: "desktop-1920x1080", width: 1920, height: 1080, expected: "left" },
  { label: "desktop-1440x900", width: 1440, height: 900, expected: "left" },
  { label: "desktop-1366x768", width: 1366, height: 768, expected: "left" },
  { label: "narrow-desktop-761x900", width: 761, height: 900, expected: "left" },
  { label: "mobile-boundary-760x900", width: 760, height: 900, expected: "top" },
  { label: "mobile-390x844", width: 390, height: 844, expected: "top" }
]);

const results = [];
const failures = [];
let browser;

try {
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewportCases) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    try {
      await page.goto(withQaParam(appUrl, viewport.label), { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.locator(".codexShell").waitFor({ state: "visible", timeout: 10_000 });
      await ensureProjectDashboard(page);
      const initial = await page.evaluate(collectLayout);
      assertLayout(viewport, initial, "initial");

      const briefEditor = await verifyProjectBriefEditor(page);
      assertBriefEditorLayout(viewport, briefEditor);

      await page.locator("button.codexSettings").click();
      await page.locator("#settings-window-title").waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        () => {
          const summaries = Array.from(document.querySelectorAll(".requestContractItem summary"));
          return (
            summaries.length >= 10 &&
            summaries.some((summary) => summary.textContent?.includes("SU2")) &&
            summaries.some((summary) => summary.textContent?.includes("XFOIL-WASM"))
          );
        },
        undefined,
        { timeout: 10_000 }
      );
      const settings = await page.evaluate(collectSettingsLayout);
      assertSettingsLayout(viewport, settings);

      const chat = await ensureStartedChatLayout(page);
      assertChatLayout(viewport, chat);

      if (consoleErrors.length) {
        failures.push(`${viewport.label}: console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
      }

      results.push({ viewport: viewport.label, initial, briefEditor, settings, chat, consoleErrors: consoleErrors.length });
    } catch (error) {
      failures.push(`${viewport.label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await page.close();
    }
  }
} finally {
  if (browser) await browser.close();
}

if (failures.length) {
  console.error("AetherOps UI layout verification: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} else {
  console.log("AetherOps UI layout verification: PASS");
  console.log(JSON.stringify(results, null, 2));
}

async function ensureProjectDashboard(page) {
  if ((await page.locator(".projectBriefBar").count()) > 0) {
    return;
  }
  const projectButtons = page.locator(".projectFolderHeader");
  if ((await projectButtons.count()) > 0) {
    await projectButtons.first().click();
  } else {
    await page.locator(".projectCreateButton").click();
  }
  await page.locator(".projectBriefBar").waitFor({ state: "visible", timeout: 10_000 });
}

async function ensureStartedChatLayout(page) {
  const state = await page.evaluate(() => JSON.parse(window.localStorage.getItem("aetherops.workspaceState") || "{}"));
  if (!state.projectId) {
    throw new Error("workspace state did not contain a project id for chat layout verification");
  }
  let snapshot = await rpc(page, "snapshots.get", [state.projectId]);
  let session = snapshot.sessions?.find((item) => !item.title?.includes("Research Workflow")) ?? snapshot.sessions?.[0];
  if (!session) {
    const sessions = await rpc(page, "sessions.createForProject", [state.projectId]);
    session = sessions?.[0];
  }
  if (!session) {
    throw new Error("project did not expose a chat session for chat layout verification");
  }
  await rpc(page, "artifacts.store", [
    state.projectId,
    {
      category: "conversation_memo",
      title: `${session.title} 메모`,
      relativePath: `artifacts/chat/${session.id}-ui-layout-verify-assistant.md`,
      mimeType: "text/markdown",
      summary: "UI layout verification conversation message.",
      content: "Assistant: UI layout verification message.",
      metadata: { role: "assistant", source: "ui-layout-verify" }
    }
  ]);
  await page.evaluate(
    ({ projectId, sessionId }) => {
      window.localStorage.setItem("aetherops.workspaceState", JSON.stringify({ projectId, sessionId, view: "chat" }));
    },
    { projectId: state.projectId, sessionId: session.id }
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.locator(".projectChatHome.chatStarted .homePromptCard").waitFor({ state: "visible", timeout: 10_000 });
  return page.evaluate(collectChatLayout);
}

async function verifyProjectBriefEditor(page) {
  const summary = page.locator(".projectBriefEditor summary");
  const summaryCount = await summary.count();
  if (summaryCount !== 1) {
    throw new Error(`expected one project brief editor summary, found ${summaryCount}`);
  }
  await summary.click({ timeoutMs: 10_000 });
  await page.locator(".briefEditorGrid").waitFor({ state: "visible", timeout: 10_000 });
  const expanded = await page.evaluate(collectBriefEditorLayout);
  await summary.click({ timeoutMs: 10_000 });
  return expanded;
}

async function rpc(page, method, args) {
  return page.evaluate(
    async ({ method: rpcMethod, args: rpcArgs }) => {
      const response = await fetch("/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: rpcMethod, args: rpcArgs })
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error || `RPC failed: ${rpcMethod}`);
      return payload.result;
    },
    { method, args }
  );
}

function assertLayout(viewport, layout, phase) {
  if (layout.runtimeErrorVisible) {
    failures.push(`${viewport.label}/${phase}: runtime error view is visible`);
  }
  if (layout.horizontalOverflow) {
    failures.push(`${viewport.label}/${phase}: horizontal overflow body=${layout.scrollWidths.body} document=${layout.scrollWidths.documentElement}`);
  }
  if (!layout.runOverviewVisible) {
    failures.push(`${viewport.label}/${phase}: compact run overview is not visible`);
  }
  if (!layout.projectBriefVisible) {
    failures.push(`${viewport.label}/${phase}: compact project brief bar is not visible`);
  }
  if (!layout.projectBrief || layout.projectBrief.height > (viewport.width <= 760 ? 260 : 190)) {
    failures.push(`${viewport.label}/${phase}: compact project brief bar is too tall: ${layout.projectBrief?.height ?? "missing"}px`);
  }
  if (layout.projectBrief && layout.runOverview && layout.runOverview.y - layout.projectBrief.y > layout.projectBrief.height + 24) {
    failures.push(`${viewport.label}/${phase}: run overview is pushed too far below project brief`);
  }
  if (layout.legacyProjectComposerCount) {
    failures.push(`${viewport.label}/${phase}: legacy expanded project composer remained`);
  }
  if (layout.legacyFlowBoardCount || layout.legacyMetricStripCount || layout.placeholderCount) {
    failures.push(
      `${viewport.label}/${phase}: legacy dashboard/placeholder UI remained flow=${layout.legacyFlowBoardCount} metrics=${layout.legacyMetricStripCount} placeholders=${layout.placeholderCount}`
    );
  }
  if (layout.primaryNavItems !== 1) {
    failures.push(`${viewport.label}/${phase}: primary sidebar should expose only one real nav item, found ${layout.primaryNavItems}`);
  }
  if (viewport.expected === "left" && !layout.sidebarLeft) {
    failures.push(`${viewport.label}/${phase}: sidebar should remain left-positioned on desktop-sized viewports`);
  }
  if (viewport.expected === "top" && !layout.sidebarTop) {
    failures.push(`${viewport.label}/${phase}: sidebar should stack above content only at mobile widths`);
  }
  if (viewport.expected === "top" && layout.sidebar?.height > Math.min(180, viewport.height * 0.4)) {
    failures.push(`${viewport.label}/${phase}: mobile sidebar is too tall at ${layout.sidebar.height}px`);
  }
  if (!layout.loopLimitVisible) {
    failures.push(`${viewport.label}/${phase}: maximum loop iteration control is not visible`);
  }
  if (layout.briefControls.approvalSelects !== 1 || layout.briefControls.policyCheckboxes !== 2 || layout.briefControls.runButtons !== 1) {
    failures.push(`${viewport.label}/${phase}: compact project controls missing ${JSON.stringify(layout.briefControls)}`);
  }
  if (layout.loopLimitValue !== "1") {
    failures.push(`${viewport.label}/${phase}: maximum loop iteration control should default to 1, found ${layout.loopLimitValue || "empty"}`);
  }
}

function assertBriefEditorLayout(viewport, editor) {
  if (!editor.open) {
    failures.push(`${viewport.label}/brief-editor: details did not open`);
  }
  if (editor.textareas !== 2 || editor.inputs !== 2) {
    failures.push(`${viewport.label}/brief-editor: expected goal/scope textareas and topic/budget inputs, found ${JSON.stringify(editor)}`);
  }
  if (editor.horizontalOverflow) {
    failures.push(`${viewport.label}/brief-editor: horizontal overflow body=${editor.scrollWidths.body} document=${editor.scrollWidths.documentElement}`);
  }
}

function assertChatLayout(viewport, chat) {
  if (!chat.visible) {
    failures.push(`${viewport.label}/chat: started chat view is not visible`);
  }
  if (chat.composerPosition === "fixed") {
    failures.push(`${viewport.label}/chat: chat composer must not use viewport-fixed positioning`);
  }
  if (viewport.expected === "left" && chat.composer && chat.sidebar && chat.composer.x < chat.sidebar.width - 1) {
    failures.push(`${viewport.label}/chat: composer overlaps the left sidebar composerX=${chat.composer.x} sidebarWidth=${chat.sidebar.width}`);
  }
  if (chat.horizontalOverflow) {
    failures.push(`${viewport.label}/chat: horizontal overflow body=${chat.scrollWidths.body} document=${chat.scrollWidths.documentElement}`);
  }
}

function assertSettingsLayout(viewport, settings) {
  if (!settings.visible) {
    failures.push(`${viewport.label}/settings: settings title is not visible`);
  }
  if (!settings.activeSettings) {
    failures.push(`${viewport.label}/settings: settings sidebar button is not active`);
  }
  if (settings.requestContractRows !== 10) {
    failures.push(`${viewport.label}/settings: expected 10 engineering request templates, found ${settings.requestContractRows}`);
  }
  if (!settings.xfoilWasmText.includes("XFOIL-WASM")) {
    failures.push(`${viewport.label}/settings: XFOIL-WASM request template is missing`);
  }
  if (!settings.su2Text.includes("SU2")) {
    failures.push(`${viewport.label}/settings: SU2 request template is missing`);
  }
  if (!settings.openVspText.includes("OpenVSP")) {
    failures.push(`${viewport.label}/settings: OpenVSP request template is missing`);
  }
  if (settings.horizontalOverflow) {
    failures.push(
      `${viewport.label}/settings: horizontal overflow body=${settings.scrollWidths.body} document=${settings.scrollWidths.documentElement}`
    );
  }
}

function collectLayout() {
  const rectFromElement = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      gridTemplateColumns: style.gridTemplateColumns,
      gridTemplateRows: style.gridTemplateRows
    };
  };
  const rectOf = (selector) => {
    const element = document.querySelector(selector);
    return element ? rectFromElement(element) : null;
  };
  const sidebar = rectOf(".codexSidebar");
  const shell = rectOf(".codexShell");
  const projectBrief = rectOf(".projectBriefBar");
  const runOverview = rectOf(".runOverview");
  const loopLimit = document.querySelector(".loopLimitControl input");
  const runtimeError = document.querySelector(".runtimeErrorView");
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  return {
    viewport: { width: viewportWidth, height: viewportHeight },
    shell,
    sidebar,
    projectBrief,
    runOverview,
    loopLimitVisible: Boolean(loopLimit && loopLimit.getBoundingClientRect().width > 0 && loopLimit.getBoundingClientRect().height > 0),
    loopLimitValue: loopLimit?.value ?? "",
    runtimeErrorVisible: Boolean(runtimeError),
    projectBriefVisible: Boolean(document.querySelector(".projectBriefBar")),
    briefControls: {
      approvalSelects: document.querySelectorAll(".briefSelectControl select").length,
      policyCheckboxes: document.querySelectorAll(".compactPolicyToggle input[type='checkbox']").length,
      runButtons: document.querySelectorAll(".briefRunButton").length
    },
    legacyProjectComposerCount: document.querySelectorAll(".projectComposer").length,
    runOverviewVisible: Boolean(document.querySelector(".runOverview")),
    legacyFlowBoardCount: document.querySelectorAll(".flowBoard, .flowBoardStructured").length,
    legacyMetricStripCount: document.querySelectorAll(".metricStrip").length,
    placeholderCount: document.querySelectorAll(".codexPlaceholder, .placeholderCard").length,
    primaryNavItems: document.querySelectorAll(".codexNavItem").length,
    sidebarLeft: Boolean(sidebar && sidebar.x === 0 && sidebar.y === 0 && sidebar.height > viewportHeight * 0.9 && sidebar.width < viewportWidth),
    sidebarTop: Boolean(sidebar && sidebar.x === 0 && sidebar.y === 0 && sidebar.width === viewportWidth && sidebar.height < viewportHeight * 0.9),
    horizontalOverflow: document.documentElement.scrollWidth > viewportWidth || document.body.scrollWidth > viewportWidth,
    scrollWidths: { body: document.body.scrollWidth, documentElement: document.documentElement.scrollWidth }
  };
}

function collectBriefEditorLayout() {
  return {
    open: document.querySelector(".projectBriefEditor")?.hasAttribute("open") ?? false,
    textareas: Array.from(document.querySelectorAll(".briefEditorGrid textarea")).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length,
    inputs: Array.from(document.querySelectorAll(".briefEditorGrid input")).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }).length,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth,
    scrollWidths: { body: document.body.scrollWidth, documentElement: document.documentElement.scrollWidth }
  };
}

function collectChatLayout() {
  const rectFromElement = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      position: style.position
    };
  };
  const composerElement = document.querySelector(".projectChatHome.chatStarted .homePromptCard");
  const sidebarElement = document.querySelector(".codexSidebar");
  const composer = composerElement ? rectFromElement(composerElement) : null;
  return {
    visible: Boolean(composerElement),
    composer,
    composerPosition: composer?.position ?? "",
    sidebar: sidebarElement ? rectFromElement(sidebarElement) : null,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth,
    scrollWidths: { body: document.body.scrollWidth, documentElement: document.documentElement.scrollWidth }
  };
}

function collectSettingsLayout() {
  const rectFromElement = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      gridTemplateColumns: style.gridTemplateColumns,
      gridTemplateRows: style.gridTemplateRows
    };
  };
  const summaries = Array.from(document.querySelectorAll(".requestContractItem summary"));
  const xfoilWasm = summaries.find((summary) => summary.textContent?.includes("XFOIL-WASM"));
  const su2 = summaries.find((summary) => summary.textContent?.includes("SU2"));
  const openVsp = summaries.find((summary) => summary.textContent?.includes("OpenVSP"));
  return {
    visible: Boolean(document.querySelector("#settings-window-title")),
    activeSettings: document.querySelector(".codexSettings")?.classList.contains("active") ?? false,
    requestContractRows: summaries.length,
    xfoilWasmText: xfoilWasm?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    xfoilWasmRect: xfoilWasm ? rectFromElement(xfoilWasm) : null,
    su2Text: su2?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    su2Rect: su2 ? rectFromElement(su2) : null,
    openVspText: openVsp?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    openVspRect: openVsp ? rectFromElement(openVsp) : null,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth,
    scrollWidths: { body: document.body.scrollWidth, documentElement: document.documentElement.scrollWidth }
  };
}

function withQaParam(url, label) {
  const next = new URL(url);
  next.searchParams.set("qa", `ui-layout-verify-${label}`);
  return next.toString();
}

function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`Invalid AetherOps UI URL: ${value}`);
  }
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--url") {
      parsed.url = values[index + 1];
      index += 1;
    } else if (value?.startsWith("--url=")) {
      parsed.url = value.slice("--url=".length);
    } else if (value) {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}
