import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmTimeoutError } from "../../../core/providers/llm.js";
import { CodexModelUnavailableError, CodexOAuthLlmProvider, type CodexExecutionSettings } from "./codexOAuthLlmProvider.js";

const request = {
  schemaName: "ProviderHarness",
  system: "System instruction",
  user: "Return a result"
};

describe("CodexOAuthLlmProvider", () => {
  let root = "";
  let codexHome = "";
  let harnessPath = "";
  let capturePath = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aetherops-codex-provider-"));
    codexHome = join(root, "codex-home");
    harnessPath = join(root, "codex-harness.mjs");
    capturePath = join(root, "calls.jsonl");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-access", refresh_token: "test-refresh", account_id: "test-account" }
      }),
      "utf8"
    );
    writeFileSync(harnessPath, HARNESS_SOURCE, "utf8");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads model, effort, and timeout settings for every JSON request and passes exact Codex argv", async () => {
    let settings: CodexExecutionSettings = { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 5_000 };
    const provider = createProvider(() => settings, "success");

    await expect(provider.completeJson(request)).resolves.toEqual({ ok: true });
    settings = { model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 7_000 };
    await expect(provider.getStatus()).resolves.toMatchObject({ catalog: "supported", access: "not_checked" });
    await expect(provider.completeJson(request)).resolves.toEqual({ ok: true });

    const executions = capturedCalls().filter((call) => call.args[0] === "exec");
    expect(executions).toHaveLength(2);
    expect(executions[0]?.args.slice(0, 7)).toEqual(["exec", "--model", "gpt-5.6", "-c", 'service_tier="fast"', "-c", 'model_reasoning_effort="xhigh"']);
    expect(executions[1]?.args.slice(0, 7)).toEqual(["exec", "--model", "gpt-5.6-terra", "-c", 'service_tier="fast"', "-c", 'model_reasoning_effort="max"']);
    await expect(provider.getStatus()).resolves.toMatchObject({ catalog: "supported", access: "available" });
    provider.dispose();
  });

  it("classifies an account model rejection without trying another model", async () => {
    const provider = createProvider({ model: "gpt-5.6-luna", reasoningEffort: "xhigh", timeoutMs: 5_000 }, "deny");

    await expect(provider.completeJson(request)).rejects.toBeInstanceOf(CodexModelUnavailableError);
    const executions = capturedCalls().filter((call) => call.args[0] === "exec");
    expect(executions).toHaveLength(1);
    expect(executions[0]?.args).toContain("gpt-5.6-luna");
    await expect(provider.getStatus()).resolves.toMatchObject({ catalog: "supported", access: "unavailable" });
    await expect(provider.isAvailable()).resolves.toBe(false);
    await expect(provider.completeJson(request)).rejects.toBeInstanceOf(CodexModelUnavailableError);
    expect(capturedCalls().filter((call) => call.args[0] === "exec")).toHaveLength(1);
    provider.dispose();
  });

  it("enforces the dynamically selected timeout", async () => {
    const provider = createProvider({ model: "gpt-5.6", reasoningEffort: "high", timeoutMs: 1_000 }, "slow");

    await expect(provider.completeJson(request)).rejects.toBeInstanceOf(LlmTimeoutError);
    provider.dispose();
  });

  it("honors CODEX_HOME when an explicit provider home is not supplied", async () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const provider = new CodexOAuthLlmProvider({
        cwd: root,
        settings: { model: "gpt-5.6", reasoningEffort: "xhigh", timeoutMs: 5_000 },
        command: process.execPath,
        commandArgsPrefix: [harnessPath, capturePath, "success"]
      });
      await expect(provider.getStatus()).resolves.toMatchObject({ authenticated: true, cliAvailable: true });
      provider.dispose();
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  function createProvider(settings: CodexExecutionSettings | (() => CodexExecutionSettings), mode: "success" | "deny" | "slow"): CodexOAuthLlmProvider {
    return new CodexOAuthLlmProvider({
      codexHome,
      cwd: root,
      settings,
      command: process.execPath,
      commandArgsPrefix: [harnessPath, capturePath, mode]
    });
  }

  function capturedCalls(): Array<{ args: string[]; stdin: string }> {
    const text = readFileSync(capturePath, "utf8").trim();
    return text ? text.split("\n").map((line) => JSON.parse(line) as { args: string[]; stdin: string }) : [];
  }
});

const HARNESS_SOURCE = `
import { appendFileSync, writeFileSync } from "node:fs";
const [capturePath, mode, ...args] = process.argv.slice(2);
let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
appendFileSync(capturePath, JSON.stringify({ args, stdin }) + "\\n", "utf8");
if (args[0] === "--version") {
  process.stdout.write("codex-harness 1.0.0\\n");
  process.exit(0);
}
if (mode === "deny") {
  process.stderr.write("Model is not available for this account entitlement.\\n");
  process.exit(2);
}
if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 2_000));
const outputIndex = args.indexOf("--output-last-message");
if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], JSON.stringify({ ok: true }), "utf8");
process.stdout.write(JSON.stringify({ ok: true }));
`;
