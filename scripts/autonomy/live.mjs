import { copyFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { assertExactLiveRuntime, requiredLiveRuntime } from "./profiles.mjs";
import { selectGoldenCases } from "./cases.mjs";
import { infrastructureFailureMessages } from "./infrastructure.mjs";
import { mapBounded } from "./process.mjs";
import { scoreLiveCase } from "./live-score.mjs";
import { startAutonomyServer, stopAutonomyServer } from "./server.mjs";

export async function runLiveVerification(context, profile, artifacts) {
  let server;
  try {
    server = await startAutonomyServer(context);
    const preflight = await configureAndVerifyRuntime(server.client);
    const work = buildWork(profile);
    const runs = await mapBounded(work, profile.concurrency, async (entry) => {
      const run = await runGoldenCase(server.client, entry.golden, entry.repetition, context.timeoutMs ?? 900_000, context.repoRoot);
      const score = scoreLiveCase(entry.golden, run);
      const path = `cases/${entry.golden.id}/run-${entry.repetition}`;
      artifacts.json(`${path}/trace.json`, run.jobDetail?.trace ?? { traceAvailability: "not_created" });
      artifacts.jsonl(`${path}/events.jsonl`, run.events ?? []);
      artifacts.json(`${path}/result.json`, { score, run: summaryOfRun(run) });
      return { run, score };
    });
    return {
      runtime: preflight.settings.codex,
      preflight,
      cases: runs.map((entry) => entry.score),
      server: { build: server.build, port: server.port, dataRoot: server.dataRoot },
      infrastructureFailures: infrastructureFailureMessages(runs)
    };
  } finally {
    if (server) {
      artifacts.json("server.json", {
        port: server.port,
        build: server.build,
        stdout: server.logs.stdout.join(""),
        stderr: server.logs.stderr.join("")
      });
      await stopAutonomyServer(server);
    }
  }
}

async function configureAndVerifyRuntime(client) {
  const current = await client.rpc("settings.get", {});
  const required = requiredLiveRuntime();
  const settings = await client.rpc("settings.save", {
    codex: required,
    embedding: withoutConfigured(current.embedding),
    search: withoutConfigured(current.search),
    capabilities: { agent: true, engineering: true, search: true }
  });
  assertExactLiveRuntime(settings);
  const auth = await client.rpc("auth.codexStatus", {});
  const llm = await client.rpc("llm.status", {});
  const diagnostics = await client.rpc("tools.diagnostics", {});
  if (!auth.authenticated) throw new Error("Live autonomy infrastructure failure: Codex OAuth is not authenticated.");
  if (!llm.available || llm.catalog !== "supported" || llm.access === "unavailable") {
    throw new Error(`Live autonomy infrastructure failure: Codex runtime is ${llm.status}/${llm.catalog}/${llm.access}.`);
  }
  if (llm.model !== required.model || llm.reasoningEffort !== required.reasoningEffort) {
    throw new Error(`Live autonomy infrastructure failure: llm.status returned ${llm.model}/${llm.reasoningEffort}.`);
  }
  const codexCli = diagnostics.tools.find((tool) => tool.name === "CodexCliTool");
  if (!codexCli || codexCli.status !== "ready") {
    throw new Error(
      `Live autonomy infrastructure failure: Codex CLI workspace execution is ${codexCli?.status ?? "missing"}: ${codexCli?.reason ?? "no diagnostic"}.`
    );
  }
  return { settings, auth, llm, diagnostics };
}

async function runGoldenCase(client, golden, repetition, timeoutMs, repoRoot) {
  const run = { repetition, events: [] };
  try {
    const created = await client.rpc("projects.create", {
      input: { goal: golden.goal, topic: golden.topic, scope: golden.scope, budget: golden.budget }
    });
    run.projectId = created.id;
    const project = await client.rpc("projects.update", {
      projectId: created.id,
      expectedRevision: created.execution.revision,
      input: {},
      capabilities: golden.projectCapabilities
    });
    if (golden.fixture) await stageFixture(client, project.id, golden.fixture, repoRoot, run);
    let receipt;
    try {
      receipt = await client.rpc("loop.start", {
        projectId: project.id,
        idempotencyKey: `autonomy-${golden.id}-${repetition}`,
        requestedCapabilities: golden.requestedCapabilities,
        toolPolicy: golden.policy
      });
    } catch (error) {
      run.enqueueError = errorRecord(error);
      return run;
    }
    run.jobId = receipt.jobId;
    let pauseRequested = false;
    try {
      run.events = await client.collectJobEvents(project.id, receipt.jobId, timeoutMs, async (event) => {
        if (pauseRequested || event.type !== "run.step.changed" || event.data?.jobId !== receipt.jobId || event.data?.step !== "EXECUTE_TOOLS") return;
        pauseRequested = true;
        try {
          await client.rpc("loop.pause", {
            projectId: project.id,
            jobId: receipt.jobId,
            expectedProjectRevision: event.projectRevision
          });
          run.pauseRequestedAtCheckpoint = event.data.checkpointId;
        } catch (error) {
          run.pauseError = errorRecord(error);
        }
      });
    } catch (error) {
      run.runtimeError = errorRecord(error);
    }
    run.jobDetail = await client.rpc("jobs.get", { projectId: project.id, jobId: receipt.jobId });
    run.snapshot = await client.rpc("snapshots.get", { projectId: project.id });
    return run;
  } catch (error) {
    run.runtimeError = errorRecord(error);
    return run;
  }
}

async function stageFixture(client, projectId, fixture, repoRoot, run) {
  const snapshot = await client.rpc("snapshots.get", { projectId });
  const projectRoot = snapshot.data?.project?.projectRoot;
  if (typeof projectRoot !== "string" || !projectRoot) throw new Error("Project snapshot did not expose its isolated project root for fixture staging.");
  const inputRoot = join(projectRoot, "artifacts", "inputs");
  mkdirSync(inputRoot, { recursive: true });
  const target = join(inputRoot, basename(fixture));
  copyFileSync(join(repoRoot, fixture), target);
  run.stagedFixture = { name: basename(fixture), artifactPath: `artifacts/inputs/${basename(fixture)}` };
}

function buildWork(profile) {
  const cases = selectGoldenCases(profile.caseIds);
  return cases.flatMap((golden) => Array.from({ length: profile.repetitions }, (_, index) => ({ golden, repetition: index + 1 })));
}

function withoutConfigured(settings) {
  const writable = { ...settings };
  delete writable.apiKeyConfigured;
  return writable;
}

function summaryOfRun(run) {
  return {
    repetition: run.repetition,
    projectId: run.projectId,
    jobId: run.jobId,
    status: run.jobDetail?.status,
    currentStep: run.jobDetail?.currentStep,
    blockedReason: run.jobDetail?.blockedReason,
    failureReason: run.jobDetail?.failureReason,
    enqueueError: run.enqueueError,
    runtimeError: run.runtimeError,
    pauseRequestedAtCheckpoint: run.pauseRequestedAtCheckpoint,
    pauseError: run.pauseError,
    stagedFixture: run.stagedFixture,
    traceAvailability: run.jobDetail?.traceAvailability,
    eventCount: run.events?.length ?? 0
  };
}

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: typeof error?.code === "string" ? error.code : undefined,
    details: error?.details
  };
}
