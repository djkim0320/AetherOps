import { defineConfig } from "vitest/config";

const common = {
  globals: true,
  testTimeout: 30_000,
  hookTimeout: 30_000
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...common,
          name: "node-unit",
          environment: "node",
          include: ["src/core/**/*.test.{ts,tsx}", "src/server/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
          exclude: ["src/server/runtime/storage/**/*.test.{ts,tsx}"]
        }
      },
      {
        test: {
          ...common,
          name: "renderer-component",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.{ts,tsx}"]
        }
      },
      {
        test: {
          ...common,
          name: "storage-integration",
          environment: "node",
          include: ["src/server/runtime/storage/**/*.test.{ts,tsx}"]
        }
      },
      {
        test: {
          ...common,
          name: "api-contract",
          environment: "node",
          include: ["tests/contract/**/*.test.{ts,tsx}"]
        }
      }
    ]
  }
});
