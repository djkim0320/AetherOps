import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_THINKING_LABEL } from "../src/chat-status.ts";

test("chat busy state uses the compact thinking label", () => {
  assert.equal(CHAT_THINKING_LABEL, "thinking");
});
