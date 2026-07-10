import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderPdfHtml } from "./reportHtml.js";

export interface PdfReportRenderInput {
  title: string;
  projectId: string;
  markdown: string;
  outputPath: string;
  createdAt: string;
}

export async function writePdfReport(input: PdfReportRenderInput): Promise<void> {
  mkdirSync(dirname(input.outputPath), { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(renderPdfHtml(input), { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    await page.pdf({
      path: input.outputPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="font-family: Arial, sans-serif; font-size: 8px; color: #6b7280; padding-left: 36px; width: 100%;">AetherOps Research Report</div>',
      footerTemplate:
        '<div style="font-family: Arial, sans-serif; font-size: 8px; color: #6b7280; padding: 0 36px; width: 100%; display: flex; justify-content: space-between;"><span>AetherOps Research Report</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      margin: { top: "18mm", right: "16mm", bottom: "18mm", left: "16mm" }
    });
  } finally {
    await browser.close();
  }
}
