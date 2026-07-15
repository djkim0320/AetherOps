import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandWithArgs } from "./engineeringProgramCommands.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("engineering process runner", () => {
  it("runs an exact argv command with bounded strict UTF-8 output", async () => {
    const result = await runCommandWithArgs(process.execPath, ["-e", "process.stdout.write('solver-ok')"], 5_000);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdoutExcerpt: "solver-ok", stderrExcerpt: "" });
  });

  it("aborts the full spawned process tree before a descendant can write output", async () => {
    root = mkdtempSync(join(tmpdir(), "aetherops-engineering-abort-"));
    const marker = join(root, "late-output.txt");
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 2000);`;
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });`,
      "setInterval(() => undefined, 1000);"
    ].join("");
    const controller = new AbortController();
    const running = runCommandWithArgs(process.execPath, ["-e", parent], 5_000, undefined, controller.signal);
    await delay(100);

    controller.abort(new Error("test cancellation"));

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject(
      (error as Error).name === "EngineeringProcessInterruptedError"
        ? { name: "EngineeringProcessInterruptedError" }
        : { message: expect.stringMatching(/taskkill|terminate/i) }
    );
    await delay(2_300);
    expect(existsSync(marker)).toBe(false);
  }, 10_000);

  it("terminates a command that exceeds the aggregate output budget", async () => {
    const running = runCommandWithArgs(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);"], 5_000);

    await expect(running).rejects.toMatchObject({ name: "EngineeringProcessOutputLimitError" });
  }, 10_000);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
