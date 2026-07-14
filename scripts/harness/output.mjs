import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { assertSanitizedArtifact, sanitizeAutonomyArtifact } from "../autonomy/sanitize.mjs";
import { renderHarnessReport } from "./report.mjs";

export async function writeHarnessArtifacts(artifacts, result, events, harness) {
  const safeResult = sanitizeAutonomyArtifact(result);
  const safeEvents = canonicalEvents(events).map((event) => sanitizeTraceEventWithoutMutation(event));
  assertMetricEnvelopesPreserved(result, safeResult);
  assertSanitizedArtifact(safeResult);
  assertSanitizedArtifact(safeEvents);
  const tracePath = artifacts.jsonl("trace-events.jsonl", safeEvents);
  if (safeEvents.length) await assertReplayableTraceReadback(tracePath, safeEvents, safeResult.runs, harness);
  const reportPath = artifacts.json("harness-report.json", safeResult);
  assertMetricEnvelopesPreserved(result, JSON.parse(readFileSync(reportPath, "utf8")));
  artifacts.text("harness-report.md", renderHarnessReport(safeResult));
  return artifacts.manifest({
    command: safeResult.command,
    evidenceClass: safeResult.evidenceClass,
    harnessVerdict: safeResult.harnessVerdict,
    harnessMechanicsVerdict: safeResult.harnessMechanicsVerdict,
    m0ReleaseReadiness: safeResult.m0ReleaseReadiness,
    releaseBlockers: safeResult.releaseBlockers,
    productVerdict: safeResult.productVerdict,
    productionSuccessEligible: false
  });
}

function sanitizeTraceEventWithoutMutation(event) {
  const sanitized = sanitizeAutonomyArtifact(event);
  if (!isDeepStrictEqual(event, sanitized)) throw new Error(`Hash-chained trace event was altered during sanitization: ${event.caseId}`);
  return sanitized;
}

async function assertReplayableTraceReadback(path, expectedRows, runs, harness) {
  if (typeof harness?.normalizeAtLeastOnceTraceDelivery !== "function" || typeof harness?.replayTrace !== "function") {
    throw new Error("Compiled trace normalization/replay exports are required for artifact readback.");
  }
  const rows = readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  if (!isDeepStrictEqual(rows, expectedRows)) throw new Error("Trace JSONL readback differs from the verified export envelope.");
  const byRun = Map.groupBy(rows, (row) => row.event.runId);
  if (byRun.size !== runs.length) throw new Error("Trace JSONL run count differs from the deterministic report.");
  for (const run of runs) {
    const delivered = byRun.get(run.id);
    if (!delivered) throw new Error(`Trace JSONL is missing a run: ${run.caseId}`);
    const normalized = harness.normalizeAtLeastOnceTraceDelivery(delivered.map((row) => row.event));
    const replay = await harness.replayTrace(normalized.events);
    if (normalized.duplicateDeliveries !== run.trace.normalizedDuplicateDeliveries) {
      throw new Error(`Trace duplicate-delivery count differs after readback: ${run.caseId}`);
    }
    if (
      replay.events.length !== run.trace.eventCount ||
      replay.rootHash !== run.trace.rootHash ||
      replay.canonicalStateHash !== run.trace.canonicalStateHash ||
      replay.canonicalTraceHash !== run.trace.canonicalTraceHash
    ) {
      throw new Error(`Trace replay receipt differs after JSONL readback: ${run.caseId}`);
    }
  }
}

function assertMetricEnvelopesPreserved(source, sanitized, path = "$") {
  if (Array.isArray(source)) {
    source.forEach((entry, index) => assertMetricEnvelopesPreserved(entry, sanitized?.[index], `${path}[${index}]`));
    return;
  }
  if (!source || typeof source !== "object") return;
  if (Object.hasOwn(source, "value")) {
    if (!Object.hasOwn(source, "unit")) throw new Error(`Metric envelope is missing its unit: ${path}`);
    if (!sanitized || typeof sanitized !== "object" || !isDeepStrictEqual(source, sanitized)) {
      throw new Error(`Safe metric envelope was altered during sanitization: ${path}`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(source)) assertMetricEnvelopesPreserved(entry, sanitized?.[key], `${path}.${key}`);
}

function canonicalEvents(events) {
  return [...events].sort((left, right) => {
    const classification = String(left.classification ?? "").localeCompare(String(right.classification ?? ""));
    if (classification) return classification;
    const caseOrder = String(left.caseId ?? "").localeCompare(String(right.caseId ?? ""));
    if (caseOrder) return caseOrder;
    const seedOrder = Number(left.seed ?? 0) - Number(right.seed ?? 0);
    if (seedOrder) return seedOrder;
    const sequenceOrder = Number(left.event?.sequence ?? left.sequence ?? 0) - Number(right.event?.sequence ?? right.sequence ?? 0);
    if (sequenceOrder) return sequenceOrder;
    return String(left.event?.eventId ?? left.eventId ?? "").localeCompare(String(right.event?.eventId ?? right.eventId ?? ""));
  });
}
