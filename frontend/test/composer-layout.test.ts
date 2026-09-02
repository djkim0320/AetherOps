import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(join(testDirectory, "..", "src", "styles.css"), "utf8");
const composer = readFileSync(join(testDirectory, "..", "src", "components", "ChatComposer.tsx"), "utf8");

test("chat composer textarea fills the available composer width", () => {
  const rule = /\.chat-composer textarea\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";

  assert.match(rule, /\bdisplay\s*:\s*block\s*;/);
  assert.match(rule, /\bwidth\s*:\s*100%\s*;/);
  assert.match(rule, /\bbox-sizing\s*:\s*border-box\s*;/);
});

test("file attachment button is grouped on the left side of the composer footer", () => {
  const footerLeft = /<div class="chat-composer-footer">([\s\S]*?)<div class="composer-actions-row">/.exec(composer)?.[1] ?? "";

  assert.match(footerLeft, /class="composer-left-row"/);
  assert.match(footerLeft, /class="attachment-add-button"/);
  assert.match(footerLeft, /composer-mode-label/);
});
