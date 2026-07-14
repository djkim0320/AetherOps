import { describe, expect, it } from "vitest";
import { migratedJobPolicyDisposition, sanitizeMigratedJobPolicy } from "../../src/migration/v2JobPolicySanitizer.mjs";

describe("legacy job policy migration sanitizer", () => {
  it("preserves a safe offline policy without inventing a fallback", () => {
    const result = sanitizeMigratedJobPolicy('{"allowCodexCli":false,"sourceAccess":{"mode":"offline"}}', '{"action":"start"}');
    expect(result).toEqual({
      unsafe: false,
      toolPolicyText: '{"allowCodexCli":false,"sourceAccess":{"mode":"offline"}}',
      payloadText: '{"action":"start"}'
    });
  });

  it("removes unsafe URL credentials from policy copies while preserving unrelated payload values", () => {
    const canary = "MIGRATION_SECRET_CANARY";
    const unrelated = {
      chat: { content: canary, token: "legitimate-domain-token", url: "https://example.com/search?q=normal" },
      engineering: { task: `Preserve ${canary} verbatim.` }
    };
    const result = sanitizeMigratedJobPolicy(
      JSON.stringify({ sourceAccess: { mode: "allowlist", urls: [`https://user:${canary}@example.com/paper?token=${canary}`] } }),
      JSON.stringify({
        ...unrelated,
        request: {
          toolPolicy: { sourceAccess: { mode: "allowlist", urls: [`https://example.com/data?sig=${canary}`] } },
          canonicalInitializationAnchor: {
            immutablePolicy: { toolPolicy: { sourceAccess: { mode: "allowlist", urls: [`https://user:${canary}@example.com/anchor`] } } }
          }
        }
      })
    );
    expect(result.unsafe).toBe(true);
    expect(result.toolPolicyText).toBeNull();
    expect(result.payloadText).toContain("[removed-unsafe-source-url]");
    expect(JSON.parse(result.payloadText)).toMatchObject(unrelated);
    expect(sanitizeMigratedJobPolicy(result.toolPolicyText, result.payloadText)).toEqual({ ...result, unsafe: false });
  });

  it("preserves unrelated payload bytes containing legitimate token fields and queried URLs", () => {
    const payload = '{ "chat": { "content": "keep me", "token": "domain vocabulary", "url": "https://example.com/?q=normal" } }';
    expect(sanitizeMigratedJobPolicy(null, payload)).toEqual({ unsafe: false, toolPolicyText: null, payloadText: payload });
  });

  it("blocks a non-terminal unsafe legacy job without rewriting unrelated payload fields", () => {
    const migrated = migratedJobPolicyDisposition(
      {
        id: "job-unsafe",
        status: "queued",
        blocked_reason: null,
        tool_policy: '{"sourceAccess":{"mode":"allowlist","urls":["https://user:secret@example.com/"]}}',
        payload: '{"chat":{"token":"domain term"},"request":{"toolPolicy":{"sourceAccess":{"mode":"offline"}}}}',
        updated_at: "2026-07-14T00:00:00.000Z"
      },
      { interruptActive: true }
    );
    expect(migrated).toMatchObject({ unsafe: true, requiresReplan: true });
    expect(migrated.row).toMatchObject({
      status: "blocked",
      tool_policy: null,
      blocked_reason: "replan_required_unsafe_source_policy_removed",
      completed_at: "2026-07-14T00:00:00.000Z"
    });
    expect(JSON.parse(migrated.row.payload)).toMatchObject({ chat: { token: "domain term" } });
  });
});
