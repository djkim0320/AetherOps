import assert from "node:assert/strict";
import test from "node:test";

import { loadBrowserOperationalStatus, loadSchedulesState } from "../src/operational-state.ts";

test("workspace operational state uses the live schedule and browser endpoints", async () => {
  const requested: string[] = [];
  const getter = async (path: string): Promise<unknown> => {
    requested.push(path);
    if (path === "/api/v1/schedules") {
      return [{ id: "schedule-1", project_id: "project-1", enabled: true }];
    }
    return { status: "ready", mode: "automatic", tab_count: 1 };
  };

  const schedules = await loadSchedulesState(getter);
  const browser = await loadBrowserOperationalStatus(getter);

  assert.deepEqual(requested, ["/api/v1/schedules", "/api/v1/browser"]);
  assert.equal(schedules[0]?.id, "schedule-1");
  assert.equal(browser.status, "ready");
  assert.equal(browser.mode, "automatic");
});

test("schedule loader accepts the documented wrapped response shape", async () => {
  const schedules = await loadSchedulesState(async () => ({ schedules: [] }));
  assert.deepEqual(schedules, []);
  assert.deepEqual(await loadSchedulesState(async () => null), []);
});

test("browser loader rejects missing status or an unknown mode", async () => {
  await assert.rejects(
    loadBrowserOperationalStatus(async () => ({ status: "ready", mode: "paused" })),
    /필수 값/
  );
  await assert.rejects(
    loadBrowserOperationalStatus(async () => ({ mode: "manual" })),
    /필수 값/
  );
});
