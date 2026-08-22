import assert from "node:assert/strict";
import test from "node:test";

import { resolveRunSelection } from "../src/model-selection.ts";
import type { JsonRecord, ModelOption } from "../src/types.ts";

const options: ModelOption[] = [
  {
    id: "gpt-5.6-terra",
    display_name: "GPT-5.6-Terra",
    default_reasoning_effort: "high",
    supported_reasoning_efforts: ["medium", "high"],
    supported_speeds: ["standard"]
  },
  {
    id: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    default_reasoning_effort: "xhigh",
    supported_reasoning_efforts: ["medium", "high", "xhigh"],
    supported_speeds: ["standard", "fast"]
  }
];

const status: JsonRecord = {
  default_run_configuration: {
    model: "gpt-5.6-sol",
    reasoning_effort: "xhigh",
    speed: "standard"
  }
};

test("visible default model is also the submitted model before preferences synchronize", () => {
  assert.deepEqual(resolveRunSelection(status, options, {
    model: "",
    effort: "",
    speed: "standard",
    contextProfile: "default"
  }), {
    model: "gpt-5.6-sol",
    effort: "xhigh",
    speed: "standard",
    contextProfile: "default",
    option: options[1]
  });
});

test("unsupported saved values are normalized and long context is Sol-only", () => {
  assert.deepEqual(resolveRunSelection(status, options, {
    model: "gpt-5.6-terra",
    effort: "xhigh",
    speed: "fast",
    contextProfile: "long_1m"
  }), {
    model: "gpt-5.6-terra",
    effort: "high",
    speed: "standard",
    contextProfile: "default",
    option: options[0]
  });
});
