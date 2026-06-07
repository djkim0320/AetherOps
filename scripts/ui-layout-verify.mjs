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

      await page.locator("button.codexSettings").click();
      await page.locator("#settings-window-title").waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        () => {
          const summaries = Array.from(document.querySelectorAll(".requestContractItem summary"));
          return summaries.length >= 9 && summaries.some((summary) => summary.textContent?.includes("SU2"));
        },
        undefined,
        { timeout: 10_000 }
      );
      const settings = await page.evaluate(collectSettingsLayout);
      assertSettingsLayout(viewport, settings);

      if (consoleErrors.length) {
        failures.push(`${viewport.label}: console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
      }

      results.push({ viewport: viewport.label, initial, settings, consoleErrors: consoleErrors.length });
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
  if ((await page.locator(".loopLimitControl input").count()) > 0) {
    return;
  }
  const projectButtons = page.locator(".projectFolderHeader");
  if ((await projectButtons.count()) > 0) {
    await projectButtons.first().click();
  } else {
    await page.locator(".projectCreateButton").click();
  }
  await page.locator(".projectComposer").waitFor({ state: "visible", timeout: 10_000 });
}

function assertLayout(viewport, layout, phase) {
  if (layout.runtimeErrorVisible) {
    failures.push(`${viewport.label}/${phase}: runtime error view is visible`);
  }
  if (layout.horizontalOverflow) {
    failures.push(`${viewport.label}/${phase}: horizontal overflow body=${layout.scrollWidths.body} document=${layout.scrollWidths.documentElement}`);
  }
  if (viewport.expected === "left" && !layout.sidebarLeft) {
    failures.push(`${viewport.label}/${phase}: sidebar should remain left-positioned on desktop-sized viewports`);
  }
  if (viewport.expected === "top" && !layout.sidebarTop) {
    failures.push(`${viewport.label}/${phase}: sidebar should stack above content only at mobile widths`);
  }
  if (!layout.loopLimitVisible) {
    failures.push(`${viewport.label}/${phase}: maximum loop iteration control is not visible`);
  }
  if (layout.loopLimitValue !== "1") {
    failures.push(`${viewport.label}/${phase}: maximum loop iteration control should default to 1, found ${layout.loopLimitValue || "empty"}`);
  }
}

function assertSettingsLayout(viewport, settings) {
  if (!settings.visible) {
    failures.push(`${viewport.label}/settings: settings title is not visible`);
  }
  if (!settings.activeSettings) {
    failures.push(`${viewport.label}/settings: settings sidebar button is not active`);
  }
  if (settings.requestContractRows !== 9) {
    failures.push(`${viewport.label}/settings: expected 9 engineering request templates, found ${settings.requestContractRows}`);
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
  const loopLimit = document.querySelector(".loopLimitControl input");
  const runtimeError = document.querySelector(".runtimeErrorView");
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  return {
    viewport: { width: viewportWidth, height: viewportHeight },
    shell,
    sidebar,
    loopLimitVisible: Boolean(loopLimit && loopLimit.getBoundingClientRect().width > 0 && loopLimit.getBoundingClientRect().height > 0),
    loopLimitValue: loopLimit?.value ?? "",
    runtimeErrorVisible: Boolean(runtimeError),
    sidebarLeft: Boolean(sidebar && sidebar.x === 0 && sidebar.y === 0 && sidebar.height > viewportHeight * 0.9 && sidebar.width < viewportWidth),
    sidebarTop: Boolean(sidebar && sidebar.x === 0 && sidebar.y === 0 && sidebar.width === viewportWidth && sidebar.height < viewportHeight * 0.9),
    horizontalOverflow: document.documentElement.scrollWidth > viewportWidth || document.body.scrollWidth > viewportWidth,
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
  const su2 = summaries.find((summary) => summary.textContent?.includes("SU2"));
  const openVsp = summaries.find((summary) => summary.textContent?.includes("OpenVSP"));
  return {
    visible: Boolean(document.querySelector("#settings-window-title")),
    activeSettings: document.querySelector(".codexSettings")?.classList.contains("active") ?? false,
    requestContractRows: summaries.length,
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
