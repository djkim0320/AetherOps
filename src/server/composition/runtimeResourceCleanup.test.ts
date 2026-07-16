import { describe, expect, it } from "vitest";
import { StartupResourceRegistry } from "./runtimeResourceCleanup.js";

describe("StartupResourceRegistry", () => {
  it("closes the controller first, dependencies in reverse construction order, and each resource once", async () => {
    const closed: string[] = [];
    const registry = new StartupResourceRegistry();
    registry.registerDependency("storage", () => {
      closed.push("storage");
    });
    registry.registerController("jobs", () => {
      closed.push("jobs");
    });
    registry.registerDependency("llm", () => {
      closed.push("llm");
    });
    registry.registerDependency("browser", () => {
      closed.push("browser");
    });

    await Promise.all([registry.close(), registry.close()]);

    expect(closed).toEqual(["jobs", "browser", "llm", "storage"]);
  });
});
