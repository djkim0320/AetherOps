import { describe, expect, it } from "vitest";
import { normalizeCodexOutputSchema, normalizeCodexOutputValue } from "./codexOutputSchema.js";
import { formatParseError } from "./llmInvocation.js";

describe("Codex structured output normalization", () => {
  it("requires every property and makes originally optional fields nullable", () => {
    expect(
      normalizeCodexOutputSchema({
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string" },
          sourceUrl: { type: "string", format: "uri" },
          format: { type: "string", enum: ["json"] }
        }
      })
    ).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["name", "sourceUrl", "format"],
      properties: {
        name: { type: "string" },
        sourceUrl: { anyOf: [{ type: "string" }, { type: "null" }] },
        format: { anyOf: [{ type: "string", enum: ["json"] }, { type: "null" }] }
      }
    });
  });

  it("removes null placeholders before runtime Zod validation", () => {
    expect(normalizeCodexOutputValue({ name: "result", optional: null, nested: { value: null }, rows: [{ note: null, id: 1 }] })).toEqual({
      name: "result",
      nested: {},
      rows: [{ id: 1 }]
    });
  });

  it("rejects unrestricted record schemas instead of weakening them", () => {
    expect(() => normalizeCodexOutputSchema({ type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } })).toThrow(
      "unrestricted record"
    );
  });

  it("summarizes the matching discriminated-union branch for one repair", () => {
    const error = {
      issues: [
        {
          code: "invalid_union",
          path: ["toolRequests", 2],
          errors: [
            [{ path: ["toolName"], message: "Expected WebFetchTool" }],
            [{ path: ["inputs", "artifacts", 0, "format"], message: "Expected markdown or json" }]
          ]
        }
      ]
    };
    expect(formatParseError(error)).toBe("toolRequests.2.inputs.artifacts.0.format: Expected markdown or json");
  });
});
