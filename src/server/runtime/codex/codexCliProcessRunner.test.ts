import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledCodexCli } from "./bundledCodexCli.js";
import { CodexCliError } from "./codexCliErrors.js";
import { buildExecArgs, CodexCliProcessRunner } from "./codexCliProcessRunner.js";
import type { CodexCliRunRequest, CodexCliStage } from "./codexCliTypes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexCliProcessRunner", () => {
  it("passes the strict workspace contract and exposes only sanitized progress", async () => {
    const root = await temporaryRoot();
    const script = join(root, "fake-codex.mjs");
    await writeFile(
      script,
      [
        "import { writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "const output = args[args.indexOf('--output-last-message') + 1];",
        "let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;",
        "if (process.env.OPENAI_API_KEY) process.exit(9);",
        "process.stdout.write(JSON.stringify({type:'thread.started'}) + '\\n');",
        "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'command_execution',secret:'not-forwarded'}}) + '\\n');",
        "writeFileSync(output, JSON.stringify({summary:'done',outputs:[{relativePath:'result.json',kind:'data'}]}));"
      ].join("\n"),
      "utf8"
    );
    const stages: string[] = [];
    const runner = new CodexCliProcessRunner(() => ({ command: process.execPath, argsPrefix: [script], packageRoot: root, version: "0.144.1" }), {
      enforcePermissionPreflight: false
    });
    const result = await runner.run(request(root, (stage) => stages.push(stage)));
    expect(result).toMatchObject({ exitCode: 0, eventCount: 2, terminationReason: "completed" });
    expect(JSON.parse(result.lastMessage)).toMatchObject({ summary: "done" });
    expect(stages).toEqual(expect.arrayContaining(["resolving_cli", "authenticating", "running", "tool_activity", "validating_output", "terminal"]));
    expect(await readFile(join(root, "final.json"), "utf8")).toContain("result.json");
  });

  it("rejects non-JSONL stdout instead of falling back to filesystem output", async () => {
    const root = await temporaryRoot();
    const script = join(root, "invalid.mjs");
    await writeFile(script, "process.stdout.write('not-json\\n');", "utf8");
    const runner = new CodexCliProcessRunner(() => ({ command: process.execPath, argsPrefix: [script], packageRoot: root, version: "0.144.1" }), {
      enforcePermissionPreflight: false
    });
    await expect(runner.run(request(root))).rejects.toMatchObject<CodexCliError>({ kind: "INVALID_OUTPUT" });
  });

  it("classifies a stdout-only usage-limit event as unavailable", async () => {
    const root = await temporaryRoot();
    const script = join(root, "usage-limit.mjs");
    await writeFile(
      script,
      "process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'You have hit your usage limit. Purchase more credits.'}}) + '\\n'); process.exitCode = 1;",
      "utf8"
    );
    const runner = new CodexCliProcessRunner(() => ({ command: process.execPath, argsPrefix: [script], packageRoot: root, version: "0.144.1" }), {
      enforcePermissionPreflight: false
    });
    await expect(runner.run(request(root))).rejects.toMatchObject<CodexCliError>({
      kind: "ENTITLEMENT_UNAVAILABLE",
      message: expect.stringContaining("usage limit")
    });
  });

  it("aborts the process without treating partial output as success", async () => {
    const root = await temporaryRoot();
    const script = join(root, "wait.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);", "utf8");
    const controller = new AbortController();
    const runner = new CodexCliProcessRunner(() => ({ command: process.execPath, argsPrefix: [script], packageRoot: root, version: "0.144.1" }), {
      enforcePermissionPreflight: false
    });
    const pending = runner.run({ ...request(root), signal: controller.signal });
    setTimeout(() => controller.abort(new Error("pause requested")), 20);
    await expect(pending).rejects.toMatchObject<CodexCliError>({ kind: "INTERRUPTED" });
  });

  it("fails closed when Windows cannot enforce the permission profile", async () => {
    const root = await temporaryRoot();
    const script = join(root, "sandbox-unavailable.mjs");
    await writeFile(script, "process.stderr.write('Restricted read-only access requires the elevated Windows sandbox backend'); process.exitCode = 1;", "utf8");
    const runner = new CodexCliProcessRunner(() => ({ command: process.execPath, argsPrefix: [script], packageRoot: root, version: "0.144.1" }), {
      platform: "win32"
    });
    await expect(runner.run(request(root))).rejects.toMatchObject<CodexCliError>({
      kind: "NOT_READY",
      message: expect.stringContaining("elevated Windows sandbox backend")
    });
  });

  it("does not mix a permission profile with the legacy sandbox flag", () => {
    const args = buildExecArgs(request("C:/staging"));
    expect(args).toContain('default_permissions="aetherops-workspace"');
    expect(args.some((item) => item.startsWith("permissions.aetherops-workspace=") && item.includes("network={enabled=false}"))).toBe(true);
    if (process.platform === "win32") expect(args).toContain('windows.sandbox="elevated"');
    expect(args).toContain("--ignore-user-config");
    expect(args).not.toContain("--sandbox");
  });

  it("loads the generated workspace permission profile in the bundled CLI", () => {
    const resolution = resolveBundledCodexCli();
    const configArgs = configOverrides(buildExecArgs(request("C:/staging")));
    const probe = spawnSync(resolution.command, [...resolution.argsPrefix, ...configArgs, "features", "list"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true
    });
    expect(probe.status, probe.stderr).toBe(0);
  });
});

function configOverrides(args: string[]): string[] {
  const overrides: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-c" && args[index + 1]) overrides.push("-c", args[index + 1]);
  }
  return overrides;
}

function request(root: string, onStage?: (stage: CodexCliStage) => void): CodexCliRunRequest {
  return {
    cwd: root,
    prompt: "bounded task",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    timeoutMs: 2_000,
    outputSchemaPath: join(root, "schema.json"),
    outputLastMessagePath: join(root, "final.json"),
    workspaceProfile: { mode: "workspace", inputsDirectoryName: "inputs", outputsDirectoryName: "outputs" },
    ...(onStage ? { onStage } : {})
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aetherops-codex-runner-"));
  roots.push(root);
  await Promise.all([writeFile(join(root, "schema.json"), "{}", "utf8"), writeFile(join(root, "profile.json"), "{}", "utf8")]);
  return root;
}
