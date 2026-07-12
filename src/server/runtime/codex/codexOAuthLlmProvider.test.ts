import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { CodexCliProcessRunner } from "./codexCliProcessRunner.js";
import { CodexModelUnavailableError, CodexOAuthLlmProvider, type CodexExecutionSettings } from "./codexOAuthLlmProvider.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexOAuthLlmProvider", () => {
  it("uses the common runner with dynamic model and reasoning settings", async () => {
    const fixture = await harness("success");
    let settings: CodexExecutionSettings = { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 5_000 };
    const provider = new CodexOAuthLlmProvider({
      appRoot: process.cwd(),
      codexHome: fixture.codexHome,
      settings: () => settings,
      runner: fixture.runner
    });
    const request = {
      schemaName: "ProviderHarness",
      system: "Return JSON.",
      user: "Return ok.",
      schema: z.object({ ok: z.literal(true) }).strict()
    };
    const first = await provider.completeJsonWithMetadata(request);
    settings = { model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 6_000 };
    const second = await provider.completeJsonWithMetadata(request);
    expect(first.value).toEqual({ ok: true });
    expect(first.metadata).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "high", repairCount: 0 });
    expect(second.metadata).toMatchObject({ model: "gpt-5.6-terra", reasoningEffort: "max" });
    const calls = (await readFile(fixture.capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]).toContain("gpt-5.6-sol");
    expect(calls[1]).toContain("gpt-5.6-terra");
    expect(calls[0]).toContain('default_permissions="aetherops-readonly"');
    provider.dispose();
  });

  it("classifies entitlement rejection without a model fallback", async () => {
    const fixture = await harness("denied");
    const provider = new CodexOAuthLlmProvider({
      appRoot: process.cwd(),
      codexHome: fixture.codexHome,
      settings: { model: "gpt-5.6-luna", reasoningEffort: "xhigh", timeoutMs: 5_000 },
      runner: fixture.runner
    });
    await expect(provider.completeJson({ schemaName: "Denied", system: "", user: "", schema: z.object({ ok: z.boolean() }) })).rejects.toBeInstanceOf(
      CodexModelUnavailableError
    );
    await expect(provider.getStatus()).resolves.toMatchObject({ access: "unavailable" });
    provider.dispose();
  });
});

async function harness(mode: "success" | "denied") {
  const root = await mkdtemp(join(tmpdir(), "aetherops-codex-provider-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const capturePath = join(root, "calls.jsonl");
  const scriptPath = join(root, "codex-harness.mjs");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test", refresh_token: "test", account_id: "test" } }),
    "utf8"
  );
  const source =
    mode === "denied"
      ? "process.stderr.write('model not available for account'); process.exit(2);"
      : [
          "import { appendFileSync, writeFileSync } from 'node:fs';",
          `const capture = ${JSON.stringify(capturePath)};`,
          "const args = process.argv.slice(2);",
          "appendFileSync(capture, JSON.stringify(args) + '\\n');",
          "const output = args[args.indexOf('--output-last-message') + 1];",
          "for await (const _chunk of process.stdin) {}",
          "process.stdout.write(JSON.stringify({type:'thread.started'}) + '\\n');",
          "writeFileSync(output, JSON.stringify({ok:true}));"
        ].join("\n");
  await writeFile(scriptPath, source, "utf8");
  return {
    codexHome,
    capturePath,
    runner: new CodexCliProcessRunner(() => ({ command: process.execPath, argsPrefix: [scriptPath], packageRoot: root, version: "0.144.1" }), {
      enforcePermissionPreflight: false
    })
  };
}
