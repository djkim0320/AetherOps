import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexCliTaskInput } from "./codexCliTypes.js";
import { prepareCodexWorkspace, validateCodexWorkspace } from "./codexCliWorkspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex CLI workspace", () => {
  it("copies hash-verified inputs and accepts exactly the declared outputs", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.json");
    await writeFile(source, '{"value":42}\n', "utf8");
    const task = sampleTask();
    const prepared = await prepareCodexWorkspace(join(root, "action"), task, [{ id: "probe", sourcePath: source, sha256: await sha256(source) }], [root]);
    expect(await readFile(join(prepared.inputsRoot, "probe", "source.json"), "utf8")).toContain("42");
    await mkdir(join(prepared.outputsRoot, "reports"), { recursive: true });
    await writeFile(join(prepared.outputsRoot, "reports", "probe.json"), '{"answer":42}\n', "utf8");
    const validated = await validateCodexWorkspace(prepared, task, {
      summary: "completed",
      outputs: [{ relativePath: "reports/probe.json", kind: "data" }]
    });
    expect(validated.outputs[0]).toMatchObject({ relativePath: "reports/probe.json", bytes: 14 });
    expect(validated.outputManifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects undeclared filesystem output", async () => {
    const { prepared, task } = await preparedWorkspace();
    await mkdir(join(prepared.outputsRoot, "reports"), { recursive: true });
    await Promise.all([
      writeFile(join(prepared.outputsRoot, "reports", "probe.json"), "{}", "utf8"),
      writeFile(join(prepared.outputsRoot, "unexpected.txt"), "unexpected", "utf8")
    ]);
    await expect(validateCodexWorkspace(prepared, task, { summary: "done", outputs: [{ relativePath: "reports/probe.json", kind: "data" }] })).rejects.toThrow(
      "undeclared"
    );
  });

  it("rejects input mutation and path traversal", async () => {
    const { prepared, task } = await preparedWorkspace();
    await writeFile(join(prepared.inputsRoot, "probe", "source.json"), "changed", "utf8");
    await expect(validateCodexWorkspace(prepared, task, { summary: "done", outputs: [{ relativePath: "reports/probe.json", kind: "data" }] })).rejects.toThrow(
      "modified"
    );
    await expect(prepareCodexWorkspace(prepared.actionRoot, { ...task, outputs: [{ relativePath: "../escape.json", kind: "data" }] }, [], [])).rejects.toThrow(
      "Invalid Codex CLI output path"
    );
  });
});

async function preparedWorkspace() {
  const root = await temporaryRoot();
  const source = join(root, "source.json");
  await writeFile(source, "{}", "utf8");
  const task = sampleTask();
  const prepared = await prepareCodexWorkspace(join(root, "action"), task, [{ id: "probe", sourcePath: source, sha256: await sha256(source) }], [root]);
  return { prepared, task };
}

function sampleTask(): CodexCliTaskInput {
  return { task: "Read the local probe and write the answer.", inputArtifactIds: ["probe"], outputs: [{ relativePath: "reports/probe.json", kind: "data" }] };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aetherops-codex-workspace-"));
  roots.push(root);
  return root;
}
