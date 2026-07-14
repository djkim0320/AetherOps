import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createStorageV2Repositories } from "./repositories.js";
import { migrateStorageV2Schema } from "./schema.js";
import {
  readCompleteTerminalCapabilityAudits,
  readCompleteTerminalLlmInvocations,
  readCompleteTerminalOutputLinks,
  readCompleteTerminalToolAttempts
} from "./terminalBoundedReadback.js";

const PROJECT_ID = "project-terminal-bounds";
const JOB_ID = "job-terminal-bounds";
const NOW = "2026-07-14T00:00:00.000Z";

describe("bounded complete terminal trace readback", () => {
  it("fails closed instead of truncating attempts, audits, LLM invocations, or output links", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateStorageV2Schema(db);
      const repositories = createStorageV2Repositories({ appDb: db });
      repositories.jobs.enqueue({
        id: JOB_ID,
        projectId: PROJECT_ID,
        operation: "research_loop",
        idempotencyKey: "terminal-bounds",
        requestHash: "terminal-bounds-request",
        createdAt: NOW,
        queuedAt: NOW
      });
      seedOverflowingTrace(db);

      expect(() => readCompleteTerminalToolAttempts(repositories, JOB_ID, "verifier")).toThrow(/bounded complete-set limit/i);
      expect(() => readCompleteTerminalCapabilityAudits(repositories, JOB_ID, "verifier")).toThrow(/bounded complete-set limit/i);
      expect(() => readCompleteTerminalLlmInvocations(repositories, JOB_ID, "transition")).toThrow(/bounded complete-set limit/i);
      expect(() => readCompleteTerminalOutputLinks(repositories, ["attempt-0000"], "transition")).toThrow(/bounded complete-set limit/i);
    } finally {
      db.close();
    }
  });
});

function seedOverflowingTrace(db: DatabaseSync): void {
  db.exec("begin immediate");
  try {
    db.prepare(
      `insert into tool_decisions
       (id,project_id,job_id,tool_name,purpose,expected_outcome,raw_selection,user_pinned,policy_status,created_at)
       values (?,?,?,?,?,?,?,?,?,?)`
    ).run("decision-terminal-bounds", PROJECT_ID, JOB_ID, "DataAnalysisTool", "Bounded readback", "Terminal rows", "{}", 0, "accepted", NOW);
    const attempt = db.prepare(
      `insert into tool_attempts
       (id,project_id,job_id,decision_id,ordinal,status,input_hash,depends_on_attempt_ids,queued_at,completed_at)
       values (?,?,?,?,?,?,?,?,?,?)`
    );
    const audit = db.prepare(
      `insert into capability_audits
       (id,project_id,job_id,operation,capability,app_allowed,project_allowed,operation_allowed,allowed,audited_at)
       values (?,?,?,?,?,?,?,?,?,?)`
    );
    const invocation = db.prepare(
      `insert into llm_invocations
       (id,project_id,job_id,model,reasoning_effort,prompt_version,schema_version,prompt_hash,repair_count,status,started_at,data)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (let index = 0; index < 1_001; index += 1) {
      const suffix = String(index).padStart(4, "0");
      attempt.run(`attempt-${suffix}`, PROJECT_ID, JOB_ID, "decision-terminal-bounds", index, "blocked", "a".repeat(64), "[]", NOW, NOW);
      audit.run(`audit-${suffix}`, PROJECT_ID, JOB_ID, "agent", "agent", 1, 1, 1, 1, NOW);
      invocation.run(
        `invocation-${suffix}`,
        PROJECT_ID,
        JOB_ID,
        "gpt-5.6-sol",
        "high",
        "planner-v1",
        "schema-v1",
        "b".repeat(64),
        0,
        "running",
        NOW,
        JSON.stringify({ provider: "codex_oauth", schemaName: "ResearchPlan" })
      );
    }
    const link = db.prepare(
      `insert into tool_output_links
       (id,project_id,job_id,attempt_id,output_kind,output_id,promoted,created_at)
       values (?,?,?,?,?,?,?,?)`
    );
    for (let index = 0; index < 1_001; index += 1) {
      const suffix = String(index).padStart(4, "0");
      link.run(`link-${suffix}`, PROJECT_ID, JOB_ID, "attempt-0000", "source", `source-${suffix}`, 0, NOW);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
