import { describe, expect, it } from "vitest";
import {
  authorizeJobCapabilities,
  buildCapabilityAuditPayload,
  JOB_KIND_CAPABILITY_POLICY,
  JOB_KIND_REQUIRED_CAPABILITIES,
  CapabilityResolver,
  type CapabilityAuditPayload
} from "../../../src/core/application/capabilities/index.js";

const now = "2026-07-10T00:00:00.000Z";

describe("CapabilityResolver", () => {
  it("keeps the canonical job capability policy map", () => {
    expect(JOB_KIND_CAPABILITY_POLICY).toEqual({
      research_loop: { agent: true, engineering: false, search: true },
      chat_reply: { agent: true, engineering: false, search: false },
      engineering_run: { agent: true, engineering: true, search: false }
    });
    expect(JOB_KIND_REQUIRED_CAPABILITIES).toEqual({
      research_loop: ["agent", "search"],
      chat_reply: ["agent"],
      engineering_run: ["agent", "engineering"]
    });
  });

  it.each([
    ["research_loop", true, false, true],
    ["chat_reply", true, false, false],
    ["engineering_run", true, true, false]
  ] as const)("authorizes %s with the required job capabilities only", (jobKind, expectAgent, expectEngineering, expectSearch) => {
    const result = authorizeJobCapabilities({
      app: { agent: true, engineering: true, search: true },
      project: { agent: true, engineering: true, search: true },
      jobKind,
      projectId: "project-1",
      jobId: "job-1",
      recordedAt: now
    });

    expect(result.allowed).toBe(true);
    expect(result.decisions.agent.allowed).toBe(expectAgent);
    expect(result.decisions.engineering.allowed).toBe(expectEngineering);
    expect(result.decisions.search.allowed).toBe(expectSearch);
    expect(result.audits).toHaveLength(3);
  });

  it.each([
    {
      label: "app denial",
      input: {
        app: { agent: false, engineering: true, search: true },
        project: { agent: true, engineering: true, search: true },
        jobKind: "chat_reply" as const,
        projectId: "project-1",
        jobId: "job-2",
        recordedAt: now
      },
      kind: "agent" as const,
      blockedBy: "app" as const
    },
    {
      label: "project denial",
      input: {
        app: { agent: true, engineering: true, search: true },
        project: { agent: true, engineering: true, search: false },
        jobKind: "research_loop" as const,
        projectId: "project-1",
        jobId: "job-3",
        recordedAt: now
      },
      kind: "search" as const,
      blockedBy: "project" as const
    },
    {
      label: "job denial",
      input: {
        app: { agent: true, engineering: true, search: true },
        project: { agent: true, engineering: true, search: true },
        jobKind: "engineering_run" as const,
        job: { agent: false },
        projectId: "project-1",
        jobId: "job-4",
        recordedAt: now
      },
      kind: "agent" as const,
      blockedBy: "job" as const
    }
  ])("blocks on %s", ({ input, kind, blockedBy }) => {
    const result = authorizeJobCapabilities(input);
    expect(result.allowed).toBe(false);
    expect(result.decisions[kind].blockedBy).toBe(blockedBy);
    expect(result.decisions[kind].reason).toContain(blockedBy === "job" ? "does not permit" : "denies");
  });

  it("builds audit payloads with app/project/job context", () => {
    const resolver = new CapabilityResolver();
    const decision = resolver.resolve("search", {
      app: { agent: true, engineering: true, search: false },
      project: { agent: true, engineering: true, search: true },
      jobKind: "research_loop",
      projectId: "project-1",
      jobId: "job-5",
      appId: "app-1"
    });
    const audit = buildCapabilityAuditPayload({
      decision,
      context: {
        appId: "app-1",
        projectId: "project-1",
        jobId: "job-5",
        jobKind: "research_loop"
      },
      recordedAt: now
    }) as CapabilityAuditPayload;

    expect(audit).toMatchObject({
      recordedAt: now,
      kind: "search",
      appId: "app-1",
      projectId: "project-1",
      jobId: "job-5",
      jobKind: "research_loop",
      appAllowed: false,
      projectAllowed: true,
      jobAllowed: true,
      allowed: false,
      blockedBy: "app"
    });
    expect(audit.appGrant).toMatchObject({ scope: "app", kind: "search", allowed: false });
  });
});
