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
      await verifyBlockedStartDoesNotCallRpc(page, viewport);

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
      const settingsDisclosure = await verifySettingsDisclosure(page);
      assertSettingsDisclosureLayout(viewport, settingsDisclosure);

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
    await ensureCodeExecutionPolicyMismatch(page);
    return;
  }
  const projectButtons = page.locator(".projectFolderHeader");
  if ((await projectButtons.count()) > 0) {
    await projectButtons.first().click();
  } else {
    await page.locator(".projectCreateButton").click();
  }
  await page.locator(".projectBriefBar").waitFor({ state: "visible", timeout: 10_000 });
  await ensureCodeExecutionPolicyMismatch(page);
}

async function ensureCodeExecutionPolicyMismatch(page) {
  const settings = await rpc(page, "settings.get", []);
  if (settings.allowCodeExecution !== false) {
    return;
  }
  const state = await page.evaluate(() => JSON.parse(window.localStorage.getItem("aetherops.workspaceState") || "{}"));
  if (!state.projectId) {
    return;
  }
  const snapshot = await rpc(page, "snapshots.get", [state.projectId]);
  if (snapshot.project.autonomyPolicy.allowCodeExecution) {
    return;
  }
  const project = snapshot.project;
  await rpc(page, "projects.update", [
    project.id,
    {
      goal: project.goal,
      topic: project.topic,
      scope: project.scope,
      budget: project.budget,
      autonomyPolicy: { ...project.autonomyPolicy, allowCodeExecution: true }
    }
  ]);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.locator(".projectBriefBar").waitFor({ state: "visible", timeout: 10_000 });
}

async function verifyBlockedStartDoesNotCallRpc(page, viewport) {
  const result = await page.evaluate(async () => {
    const button = document.querySelector(".briefRunButton");
    const status = document.querySelector(".briefStartStatus");
    if (!(button instanceof HTMLButtonElement)) {
      return { skipped: "start button missing", calls: [] };
    }
    if (!status) {
      return { skipped: "blocked start status missing", calls: [] };
    }
    const originalFetch = window.fetch.bind(window);
    const calls = [];
    window.fetch = async (...args) => {
      try {
        const request = args[0];
        const init = args[1];
        const url = typeof request === "string" ? request : request instanceof Request ? request.url : "";
        const body = typeof init?.body === "string" ? init.body : "";
        if (url.includes("/api/rpc") && body) {
          const payload = JSON.parse(body);
          calls.push(payload.method);
        }
      } catch {
        calls.push("unreadable-rpc");
      }
      return originalFetch(...args);
    };
    const originallyDisabled = button.disabled;
    button.disabled = false;
    button.click();
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    button.disabled = originallyDisabled;
    window.fetch = originalFetch;
    return {
      skipped: "",
      calls,
      statusText: status.textContent?.replace(/\s+/g, " ").trim() ?? ""
    };
  });
  if (result.skipped) {
    failures.push(`${viewport.label}/blocked-start: ${result.skipped}`);
    return;
  }
  const forbiddenCalls = result.calls.filter((method) =>
    ["projects.update", "research.inputResearchQuestionHypothesis", "loop.start"].includes(method)
  );
  if (forbiddenCalls.length) {
    failures.push(`${viewport.label}/blocked-start: blocked start triggered RPCs ${forbiddenCalls.join(", ")}`);
  }
  if (!result.statusText) {
    failures.push(`${viewport.label}/blocked-start: blocked start reason was empty`);
  }
}

async function ensureStartedChatLayout(page) {
  const state = await page.evaluate(() => JSON.parse(window.localStorage.getItem("aetherops.workspaceState") || "{}"));
  if (!state.projectId) {
    throw new Error("workspace state did not contain a project id for chat layout verification");
  }
  const snapshot = await rpc(page, "snapshots.get", [state.projectId]);
  let session = snapshot.sessions?.find((item) => !item.title?.includes("Research Workflow")) ?? snapshot.sessions?.[0];
  if (!session) {
    throw new Error("project did not expose a real chat session for chat layout verification");
  }
  await page.evaluate(
    ({ projectId, sessionId }) => {
      window.localStorage.setItem("aetherops.workspaceState", JSON.stringify({ projectId, sessionId, view: "chat" }));
    },
    { projectId: state.projectId, sessionId: session.id }
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.locator(".projectChatHome .homePromptCard").waitFor({ state: "visible", timeout: 10_000 });
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
  if (!layout.contentFirstPanel) {
    failures.push(`${viewport.label}/${phase}: content grid did not expose a first panel`);
  } else if (!layout.contentFirstPanel.includes("engineeringWorkbenchPanel")) {
    failures.push(`${viewport.label}/${phase}: engineering workbench must be the first content panel, found ${layout.contentFirstPanel}`);
  }
  if (!layout.workbench) {
    failures.push(`${viewport.label}/${phase}: engineering workbench panel is missing`);
  }
  if (!layout.agentPanel) {
    failures.push(`${viewport.label}/${phase}: research summary panel is missing`);
  }
  if (!layout.finalPanel) {
    failures.push(`${viewport.label}/${phase}: final output panel is missing`);
  }
  if (layout.agentPanel && layout.workbench && layout.workbench.y > layout.agentPanel.y) {
    failures.push(`${viewport.label}/${phase}: engineering workbench must render before the research summary`);
  }
  if (layout.finalPanel && layout.workbench && layout.workbench.y > layout.finalPanel.y) {
    failures.push(`${viewport.label}/${phase}: engineering workbench must stay above final output`);
  }
  if (layout.legacyProjectComposerCount) {
    failures.push(`${viewport.label}/${phase}: legacy expanded project composer remained`);
  }
  if (layout.legacyFlowBoardCount || layout.legacyMetricStripCount || layout.placeholderCount) {
    failures.push(
      `${viewport.label}/${phase}: legacy dashboard/placeholder UI remained flow=${layout.legacyFlowBoardCount} metrics=${layout.legacyMetricStripCount} placeholders=${layout.placeholderCount}`
    );
  }
  if (layout.ghostButtons !== 0) {
    failures.push(`${viewport.label}/${phase}: inert ghost buttons must not remain, found ${layout.ghostButtons}`);
  }
  if (layout.collapsiblePanels < 4) {
    failures.push(`${viewport.label}/${phase}: expected at least four compact dashboard disclosure panels, found ${layout.collapsiblePanels}`);
  }
  if (layout.openCollapsiblePanels !== 0) {
    failures.push(`${viewport.label}/${phase}: dashboard disclosure panels should be closed by default, found ${layout.openCollapsiblePanels} open`);
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
  if (viewport.expected === "top" && !layout.mobileSessionNavigationVisible) {
    failures.push(`${viewport.label}/${phase}: mobile sidebar must keep project dashboard/chat session navigation visible`);
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
  for (const policy of layout.policyControls) {
    if (policy.blocked && !policy.checked && !policy.disabled) {
      failures.push(`${viewport.label}/${phase}: blocked policy "${policy.text}" can be newly enabled`);
    }
  }
  if (layout.policyControls.some((policy) => policy.blocked && policy.checked)) {
    if (!layout.startButton.disabled) {
      failures.push(`${viewport.label}/${phase}: start button is enabled while a requested policy is blocked by app settings`);
    }
    if (!layout.startButton.text.includes("설정 필요")) {
      failures.push(`${viewport.label}/${phase}: start button should show the settings-required state, found "${layout.startButton.text}"`);
    }
    if (!layout.startButton.statusText || layout.startButton.describedBy !== "project-start-status") {
      failures.push(`${viewport.label}/${phase}: blocked start state must expose a visible aria-described reason`);
    }
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
    failures.push(`${viewport.label}/chat: chat composer view is not visible`);
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
  if (settings.settingsDisclosures < 2) {
    failures.push(`${viewport.label}/settings: expected OpenCode and engineering settings disclosures, found ${settings.settingsDisclosures}`);
  }
  if (settings.openSettingsDisclosures !== 0) {
    failures.push(`${viewport.label}/settings: advanced settings disclosures should be closed by default, found ${settings.openSettingsDisclosures} open`);
  }
  if (!settings.embeddingProviderOptions.some((option) => option.value === "local" && option.text.includes("blocked"))) {
    failures.push(`${viewport.label}/settings: local embedding option must remain explicit and marked blocked`);
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

function assertSettingsDisclosureLayout(viewport, settingsDisclosure) {
  if (!settingsDisclosure.openCodeOpen) {
    failures.push(`${viewport.label}/settings-disclosure: OpenCode disclosure did not open`);
  }
  if (!settingsDisclosure.engineeringOpen) {
    failures.push(`${viewport.label}/settings-disclosure: engineering disclosure did not open`);
  }
  if (!settingsDisclosure.openCodeCommandVisible) {
    failures.push(`${viewport.label}/settings-disclosure: OpenCode command control is not visible after opening`);
  }
  if (settingsDisclosure.visibleRequestContractRows !== 10) {
    failures.push(
      `${viewport.label}/settings-disclosure: expected 10 visible engineering request templates after opening, found ${settingsDisclosure.visibleRequestContractRows}`
    );
  }
  if (!settingsDisclosure.xfoilCommandVisible) {
    failures.push(`${viewport.label}/settings-disclosure: XFOIL command control is not visible after opening`);
  }
  if (settingsDisclosure.horizontalOverflow) {
    failures.push(
      `${viewport.label}/settings-disclosure: horizontal overflow body=${settingsDisclosure.scrollWidths.body} document=${settingsDisclosure.scrollWidths.documentElement}`
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
  const agentPanel = rectOf(".agentPanel");
  const finalPanel = rectOf(".finalPanel");
  const workbench = rectOf(".engineeringWorkbenchPanel");
  const contentFirstPanel = document.querySelector(".contentGrid > .panel")?.className ?? "";
  const loopLimit = document.querySelector(".loopLimitControl input");
  const startButton = document.querySelector(".briefRunButton");
  const startStatus = document.querySelector(".briefStartStatus");
  const runtimeError = document.querySelector(".runtimeErrorView");
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const visibleSessionNavigationItems = Array.from(
    document.querySelectorAll(".sessionList .codexConversation, .sessionList .sessionSelectButton")
  ).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).length;
  return {
    viewport: { width: viewportWidth, height: viewportHeight },
    shell,
    sidebar,
    projectBrief,
    runOverview,
    agentPanel,
    finalPanel,
    workbench,
    contentFirstPanel,
    loopLimitVisible: Boolean(loopLimit && loopLimit.getBoundingClientRect().width > 0 && loopLimit.getBoundingClientRect().height > 0),
    loopLimitValue: loopLimit?.value ?? "",
    startButton: {
      disabled: Boolean(startButton?.disabled),
      text: startButton?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      describedBy: startButton?.getAttribute("aria-describedby") ?? "",
      statusText: startStatus?.textContent?.replace(/\s+/g, " ").trim() ?? ""
    },
    policyControls: Array.from(document.querySelectorAll(".compactPolicyToggle")).map((element) => {
      const input = element.querySelector("input");
      return {
        text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
        blocked: element.classList.contains("blocked"),
        checked: Boolean(input?.checked),
        disabled: Boolean(input?.disabled)
      };
    }),
    runtimeErrorVisible: Boolean(runtimeError),
    projectBriefVisible: Boolean(document.querySelector(".projectBriefBar")),
    briefControls: {
      approvalSelects: document.querySelectorAll(".briefSelectControl select").length,
      policyCheckboxes: document.querySelectorAll(".compactPolicyToggle input[type='checkbox']").length,
      runButtons: document.querySelectorAll(".briefRunButton").length
    },
    legacyProjectComposerCount: document.querySelectorAll(".projectComposer").length,
    runOverviewVisible: Boolean(document.querySelector(".runOverview")),
    mobileSessionNavigationVisible: viewportWidth > 760 || visibleSessionNavigationItems > 0,
    legacyFlowBoardCount: document.querySelectorAll(".flowBoard, .flowBoardStructured").length,
    legacyMetricStripCount: document.querySelectorAll(".metricStrip").length,
    placeholderCount: document.querySelectorAll(".codexPlaceholder, .placeholderCard").length,
    ghostButtons: document.querySelectorAll(".ghostButton").length,
    collapsiblePanels: document.querySelectorAll(".collapsiblePanel").length,
    openCollapsiblePanels: document.querySelectorAll(".collapsiblePanel[open]").length,
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
  const composerElement = document.querySelector(".projectChatHome .homePromptCard");
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
  const embeddingProvider = document.querySelector(".embeddingProviderSelect");
  return {
    visible: Boolean(document.querySelector("#settings-window-title")),
    activeSettings: document.querySelector(".codexSettings")?.classList.contains("active") ?? false,
    settingsDisclosures: document.querySelectorAll(".settingsDisclosure").length,
    openSettingsDisclosures: document.querySelectorAll(".settingsDisclosure[open]").length,
    requestContractRows: summaries.length,
    xfoilWasmText: xfoilWasm?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    xfoilWasmRect: xfoilWasm ? rectFromElement(xfoilWasm) : null,
    su2Text: su2?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    su2Rect: su2 ? rectFromElement(su2) : null,
    openVspText: openVsp?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    openVspRect: openVsp ? rectFromElement(openVsp) : null,
    embeddingProviderOptions: embeddingProvider
      ? Array.from(embeddingProvider.querySelectorAll("option")).map((option) => ({ value: option.value, text: option.textContent ?? "" }))
      : [],
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth,
    scrollWidths: { body: document.body.scrollWidth, documentElement: document.documentElement.scrollWidth }
  };
}

async function verifySettingsDisclosure(page) {
  await page.locator(".openCodeSettingsDisclosure > summary").click();
  await page.locator(".openCodeSettingsDisclosure[open]").waitFor({ state: "attached", timeout: 10_000 });
  await page.locator(".engineeringSettingsDisclosure > summary").click();
  await page.locator(".engineeringSettingsDisclosure[open]").waitFor({ state: "attached", timeout: 10_000 });
  return page.evaluate(collectSettingsDisclosureLayout);
}

function collectSettingsDisclosureLayout() {
  const isVisible = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const visibleRequestContractRows = Array.from(document.querySelectorAll(".requestContractItem summary")).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).length;
  return {
    openCodeOpen: document.querySelector(".openCodeSettingsDisclosure")?.hasAttribute("open") ?? false,
    engineeringOpen: document.querySelector(".engineeringSettingsDisclosure")?.hasAttribute("open") ?? false,
    openCodeCommandVisible: isVisible(".openCodeSettingsDisclosure input[list='opencode-command-options'], .openCodeSettingsDisclosure select"),
    visibleRequestContractRows,
    xfoilCommandVisible: isVisible(".engineeringSettingsDisclosure input[list='xfoil-command-options']"),
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
