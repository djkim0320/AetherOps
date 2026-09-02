import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSER_PROMPT_CHIPS,
  composerModePresentation,
  shouldBootstrapPlanCycle,
  shouldStartPlanCycleFromSlashArgument
} from "../src/composer-mode.ts";

test("plan quick chip enters plan mode directly", () => {
  const planChip = COMPOSER_PROMPT_CHIPS.find((chip) => chip.label === "계획 수립");

  assert.deepEqual(planChip, { label: "계획 수립", kind: "mode", value: "plan" });
});

test("plan mode presentation announces its selected state", () => {
  assert.deepEqual(composerModePresentation("plan"), {
    active: true,
    glyph: "P",
    label: "계획 모드 · 선택됨",
    placeholder: "계획할 작업과 검증 범위를 설명하세요…"
  });
  assert.equal(composerModePresentation("chat").active, false);
});

test("the first submitted plan prompt bootstraps a plan cycle", () => {
  assert.equal(shouldBootstrapPlanCycle("plan", false), true);
  assert.equal(shouldBootstrapPlanCycle("plan", true), false);
  assert.equal(shouldBootstrapPlanCycle("chat", false), false);
});

test("bare /plan selects the mode without starting a remote plan cycle", () => {
  assert.equal(shouldStartPlanCycleFromSlashArgument(""), false);
  assert.equal(shouldStartPlanCycleFromSlashArgument("   "), false);
  assert.equal(shouldStartPlanCycleFromSlashArgument("시스템 병목을 분석해줘"), true);
});
