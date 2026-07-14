import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { invocationMetadataFromError } from "../../../core/providers/llm.js";
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
      schema: z.object({ ok: z.literal(true) }).strict(),
      invocationReceipt: testReceipt("provider-harness-1")
    };
    await expect(provider.contextIdentity()).resolves.toMatchObject({
      providerId: "codex-oauth",
      modelId: "gpt-5.6-sol",
      capabilityReceipt: {
        profile: {
          structuredOutput: { supported: true, strict: true, transport: "json_schema" },
          nativeContext: { canonicalStateAuthority: false, role: "derived_cache_only" },
          nativeCompaction: { canonicalStateAuthority: false, role: "derived_cache_only" }
        },
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
    const first = await provider.completeJsonWithMetadata(request);
    settings = { model: "gpt-5.6-terra", reasoningEffort: "max", timeoutMs: 6_000 };
    await expect(provider.contextIdentity()).resolves.toMatchObject({ providerId: "codex-oauth", modelId: "gpt-5.6-terra" });
    const second = await provider.completeJsonWithMetadata({ ...request, invocationReceipt: testReceipt("provider-harness-2") });
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
    await expect(
      provider.completeJson({
        schemaName: "Denied",
        system: "",
        user: "",
        schema: z.object({ ok: z.boolean() }),
        invocationReceipt: testReceipt("provider-denied")
      })
    ).rejects.toBeInstanceOf(CodexModelUnavailableError);
    await expect(provider.getStatus()).resolves.toMatchObject({ access: "unavailable" });
    provider.dispose();
  });

  it("commits the safe running receipt before spawning Codex and keeps one invocation identity", async () => {
    const fixture = await harness("success");
    const provider = new CodexOAuthLlmProvider({
      appRoot: process.cwd(),
      codexHome: fixture.codexHome,
      settings: { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 5_000 },
      runner: fixture.runner
    });
    const running: unknown[] = [];
    const completion = await provider.completeJsonWithMetadata({
      schemaName: "ReceiptHarness",
      promptVersion: "receipt-v1",
      schemaVersion: "receipt-schema-v1",
      system: "PRIVATE_SYSTEM_SENTINEL",
      user: "PRIVATE_USER_SENTINEL",
      schema: z.object({ ok: z.literal(true) }).strict(),
      invocationReceipt: {
        invocationId: "invocation-stable-1",
        onRunning: (metadata) => {
          expect(existsSync(fixture.capturePath)).toBe(false);
          running.push(metadata);
        }
      }
    });

    expect(running).toEqual([
      expect.objectContaining({
        invocationId: "invocation-stable-1",
        status: "running",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        promptHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    expect(completion.metadata).toMatchObject({ invocationId: "invocation-stable-1", status: "completed" });
    expect(JSON.stringify(running)).not.toMatch(/PRIVATE_(SYSTEM|USER)_SENTINEL/);
    provider.dispose();
  });

  it("does not spawn Codex when the durable running receipt cannot be committed", async () => {
    const fixture = await harness("success");
    const provider = new CodexOAuthLlmProvider({
      appRoot: process.cwd(),
      codexHome: fixture.codexHome,
      settings: { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 5_000 },
      runner: fixture.runner
    });

    await expect(
      provider.completeJsonWithMetadata({
        schemaName: "ReceiptWriteFailure",
        system: "Return JSON.",
        user: "Return ok.",
        schema: z.object({ ok: z.literal(true) }).strict(),
        invocationReceipt: {
          invocationId: "invocation-write-failed",
          onRunning: () => {
            throw new Error("durable receipt write failed");
          }
        }
      })
    ).rejects.toThrow(/durable receipt write failed/i);
    expect(existsSync(fixture.capturePath)).toBe(false);
    provider.dispose();
  });

  it("blocks an unpersisted diagnostic invocation before spawning Codex", async () => {
    const fixture = await harness("success");
    const provider = new CodexOAuthLlmProvider({
      appRoot: process.cwd(),
      codexHome: fixture.codexHome,
      settings: { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 5_000 },
      runner: fixture.runner
    });

    await expect(
      provider.completeJsonWithMetadata({
        schemaName: "UnpersistedDiagnostic",
        system: "Return JSON.",
        user: "Return ok.",
        schema: z.object({ ok: z.literal(true) }).strict()
      })
    ).rejects.toThrow(/NOT_READY.*durable pre-spawn invocation receipt/i);
    expect(existsSync(fixture.capturePath)).toBe(false);
    provider.dispose();
  });

  it("keeps malformed provider response fragments out of thrown and durable validation summaries", async () => {
    const fixture = await harness("malformed");
    const provider = new CodexOAuthLlmProvider({
      appRoot: process.cwd(),
      codexHome: fixture.codexHome,
      settings: { model: "gpt-5.6-sol", reasoningEffort: "high", timeoutMs: 5_000 },
      runner: fixture.runner
    });
    let observed: unknown;

    try {
      await provider.completeJsonWithMetadata({
        schemaName: "MalformedResponse",
        system: "Return JSON.",
        user: "Return ok.",
        schema: z.object({ ok: z.literal(true) }).strict(),
        invocationReceipt: testReceipt("provider-malformed")
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect(observed instanceof Error ? observed.message : String(observed)).toBe(
      "LLM JSON schema validation failed after one repair: response:invalid_json; response:invalid_json"
    );
    const metadata = invocationMetadataFromError(observed);
    expect(metadata).toMatchObject({ status: "failed", repairCount: 1, validationErrors: ["response:invalid_json", "response:invalid_json"] });
    expect(JSON.stringify({ error: observed instanceof Error ? observed.message : observed, metadata })).not.toContain("PROVIDER_RESPONSE_CANARY");
    provider.dispose();
  });
});

function testReceipt(invocationId: string) {
  return { invocationId, onRunning: () => undefined };
}

async function harness(mode: "success" | "denied" | "malformed") {
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
          mode === "malformed" ? "writeFileSync(output, '{\"private\":PROVIDER_RESPONSE_CANARY_12345}');" : "writeFileSync(output, JSON.stringify({ok:true}));"
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
