import { chromium } from "playwright";
import { createRequire } from "node:module";

import { assertChatLayout, assertTheme } from "./assertions.mjs";
import { collectChatLayout, initializePreferences, normalizeUrl, parseArgs, routeUrl, themes, viewportCases } from "./runtime.mjs";

const axeSource = createRequire(import.meta.url)("axe-core").source;

export async function runUiLayoutVerification(rawArgs) {
  const args = parseArgs(rawArgs);
  const appUrl = normalizeUrl(args.url ?? process.env.AETHEROPS_UI_URL ?? "http://127.0.0.1:5179");
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const failures = [];
  try {
    for (const viewport of viewportCases) {
      for (const theme of themes) {
        const label = `${viewport.label}/${theme}`;
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const consoleErrors = [];
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        try {
          await initializePreferences(page, theme);
          await page.goto(routeUrl(appUrl, "/projects"), { waitUntil: "domcontentloaded", timeout: 15_000 });
          await page.locator("#projects-title").waitFor({ state: "visible", timeout: 10_000 });
          const openChat = page.getByRole("link", { name: /Open chat/i }).first();
          await openChat.waitFor({ state: "visible", timeout: 10_000 });
          await openChat.click();
          await page.locator("#chat-title").waitFor({ state: "visible", timeout: 10_000 });
          const layout = await collectChatLayout(page);
          failures.push(...assertChatLayout(layout, label), ...assertTheme(layout, theme, label));
          failures.push(...(await seriousAccessibilityFailures(page, `${label}/chat`)));

          const evidenceTab = page.getByRole("tab", { name: "Evidence" });
          await evidenceTab.waitFor({ state: "visible", timeout: 2_000 });
          await evidenceTab.click();
          await page.waitForURL((url) => url.searchParams.get("inspector") === "evidence", { timeout: 2_000 });
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
          const reloadedEvidenceTab = page.getByRole("tab", { name: "Evidence" });
          await reloadedEvidenceTab.waitFor({ state: "visible", timeout: 5_000 });
          if ((await reloadedEvidenceTab.getAttribute("aria-selected")) !== "true") {
            failures.push(`${label}: inspector deep-link did not select Evidence`);
          }
          await page.goto(routeUrl(appUrl, "/settings/codex"));
          await page.getByRole("heading", { name: "Codex" }).waitFor({ state: "visible", timeout: 10_000 });
          failures.push(...(await seriousAccessibilityFailures(page, `${label}/settings`)));
          if (consoleErrors.length) failures.push(`${label}: console errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
          results.push({ label, layout, consoleErrors: consoleErrors.length });
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error("AetherOps UI verification: FAIL");
    for (const failure of failures) console.error(`- ${failure}`);
    return { exitCode: 1, results, failures };
  }
  console.log("AetherOps UI verification: PASS");
  return { exitCode: 0, results, failures };
}

async function seriousAccessibilityFailures(page, label) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.slice(0, 3).map((node) => node.target.join(" "))
      }));
  });
  return violations.map((violation) => `${label}: axe ${violation.impact} ${violation.id} (${violation.targets.join(", ")})`);
}
