/* @vitest-environment jsdom */

import viteConfig from "../../../vite.config.js";

describe("Vite deep-link assets", () => {
  it("emits root-absolute asset URLs for nested route reloads", () => {
    expect(viteConfig.base).toBe("/");

    const nestedRoute = new URL("http://127.0.0.1:5180/projects/project-42/chats/session-9");
    const emittedAsset = new URL("/assets/index.js", nestedRoute);

    expect(emittedAsset.pathname).toBe("/assets/index.js");
  });
});
