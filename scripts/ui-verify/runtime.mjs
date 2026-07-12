export const viewportCases = Object.freeze([
  { label: "1280x720", width: 1280, height: 720 },
  { label: "1366x768", width: 1366, height: 768 },
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 }
]);

export const themes = Object.freeze(["dark", "light"]);

export function parseArgs(values) {
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

export function normalizeUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`Invalid AetherOps UI URL: ${value}`);
  }
}

export function routeUrl(baseUrl, path) {
  return new URL(path, baseUrl).toString();
}

export async function initializePreferences(page, theme) {
  await page.addInitScript((selectedTheme) => {
    window.localStorage.setItem("aetherops.theme:v1", selectedTheme);
    window.localStorage.setItem("aetherops.shellPreferences:v1", "false");
  }, theme);
}

export async function collectChatLayout(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return undefined;
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right };
    };
    const rail = document.querySelector('[data-ui="project-rail"]');
    const inspector = document.querySelector('[data-ui="project-inspector"]');
    const workspace = document.querySelector('[data-ui="workspace"]');
    const runBar = document.querySelector('[data-ui="run-bar"]');
    return {
      theme: document.documentElement.dataset.theme,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rail: rect(rail),
      inspector: rect(inspector),
      workspace: rect(workspace),
      runBar: rect(runBar),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth || document.body.scrollWidth > window.innerWidth,
      desktopGate: Boolean(document.querySelector("#desktop-required-title")),
      chatHeading: document.querySelector("#chat-title")?.textContent?.trim(),
      inspectorTabs: Array.from(document.querySelectorAll('[aria-label="인스펙터 보기"] [role="tab"]')).map((tab) => ({
        text: tab.textContent?.trim(),
        selected: tab.getAttribute("aria-selected") === "true"
      }))
    };
  });
}
