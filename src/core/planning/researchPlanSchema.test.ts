import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getToolDescriptor } from "../tools/toolDescriptors.js";
import { createResearchPlanLlmOutputSchema } from "./researchPlanSchema.js";

const allowedUrl = "https://www.rfc-editor.org/rfc/rfc9110.html";

describe("research plan source policy", () => {
  it("accepts only exact allowlisted fetch URLs", () => {
    const schema = createResearchPlanLlmOutputSchema([descriptor("WebFetchTool")], { mode: "allowlist", urls: [allowedUrl] });
    expect(schema.safeParse(plan("WebFetchTool", { urls: [allowedUrl] }, [allowedUrl])).success).toBe(true);
    expect(schema.safeParse(plan("WebFetchTool", { urls: ["https://example.com/out-of-scope"] }, [])).success).toBe(false);
  });

  it("rejects broad browser discovery in allowlist mode and all URLs in offline mode", () => {
    const browser = createResearchPlanLlmOutputSchema([descriptor("BackgroundBrowserTool")], { mode: "allowlist", urls: [allowedUrl] });
    expect(browser.safeParse(plan("BackgroundBrowserTool", { query: "broad search" }, [])).success).toBe(false);
    const offline = createResearchPlanLlmOutputSchema([descriptor("WebFetchTool")], { mode: "offline" });
    expect(offline.safeParse(plan("WebFetchTool", { urls: [allowedUrl] }, [allowedUrl])).success).toBe(false);
  });

  it("emits a structured-output schema without unrestricted record keywords", () => {
    const schema = createResearchPlanLlmOutputSchema([descriptor("WebFetchTool"), descriptor("DataAnalysisTool")]);
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
    expect(jsonSchema).not.toContain('"propertyNames"');
    expect(jsonSchema).not.toContain('"format":"uri"');
    expect(jsonSchema).not.toContain('"inputs":{}');
  });

  it("rejects an all-target probe when the user explicitly pinned SU2", () => {
    const schema = createResearchPlanLlmOutputSchema([descriptor("EngineeringProgramTool")], { mode: "offline" }, "su2");
    expect(schema.safeParse(plan("EngineeringProgramTool", { programRequests: [{ kind: "toolchain-check", target: "all" }] }, [])).success).toBe(false);
    expect(schema.safeParse(plan("EngineeringProgramTool", { programRequests: [{ kind: "toolchain-check", target: "su2" }] }, [])).success).toBe(false);
    expect(schema.safeParse(plan("EngineeringProgramTool", { programRequests: [{ kind: "su2-case-run", target: "su2" }] }, [])).success).toBe(true);
  });

  it("requires explicit PDF ingestion when a PDF resource is pinned", () => {
    const pdfUrl = "https://arxiv.org/pdf/1706.03762";
    const schema = createResearchPlanLlmOutputSchema(
      [descriptor("WebFetchTool"), descriptor("PdfIngestionTool")],
      { mode: "allowlist", urls: [pdfUrl] },
      undefined,
      ["WebFetchTool", "PdfIngestionTool"]
    );
    expect(schema.safeParse(plan("WebFetchTool", { urls: [pdfUrl] }, [pdfUrl])).success).toBe(false);
    const complete = plan("WebFetchTool", { urls: [pdfUrl] }, [pdfUrl]);
    complete.toolRequests.push({
      intentId: "intent-2",
      toolName: "PdfIngestionTool",
      purpose: "Ingest the PDF.",
      expectedOutcome: "Parsed PDF text.",
      inputs: { urls: [pdfUrl] }
    });
    expect(schema.safeParse(complete).success).toBe(true);
  });
});

function descriptor(name: string) {
  const value = getToolDescriptor(name);
  if (!value) throw new Error(`Missing descriptor: ${name}`);
  return value;
}

function plan(toolName: string, inputs: Record<string, unknown>, fetchCandidateUrls: string[]) {
  return {
    objective: "Execute a bounded source plan.",
    targetQuestions: [],
    targetHypotheses: [],
    toolRequests: [{ intentId: "intent-1", toolName, purpose: "Acquire the source.", expectedOutcome: "One validated source.", inputs }],
    expectedSources: [],
    expectedArtifacts: [],
    executionSteps: ["Run the selected tool."],
    stopCriteria: ["The selected tool completes."],
    fetchCandidateUrls
  };
}
