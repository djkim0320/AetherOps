import assert from "node:assert/strict";
import test from "node:test";

import { runEventLabel } from "../src/run-event-display.ts";

test("capability recovery events are presented as user-facing activity", () => {
  assert.equal(runEventLabel("stage.retry_authorized"), "툴 계약을 조정하고 계획을 다시 시도합니다");
  assert.equal(runEventLabel("tool.package_proposed"), "필요한 프로젝트 툴을 구성했습니다");
});

test("unknown event kinds remain inspectable", () => {
  assert.equal(runEventLabel("custom.event"), "custom.event");
});
