import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

const boundedWorkers = Math.min(4, Math.max(1, availableParallelism() - 1));
const common = {
  globals: true,
  maxWorkers: boundedWorkers,
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
