package research

import "github.com/djkim0320/AetherOps/internal/reportdocx"

const reportArtifactTemplateVersion = reportdocx.TemplateVersion

// reportArtifactTemplatePolicy keeps the model-authored body readable while
// the core continues to own citations, engineering appendices, CAS receipts,
// and knowledge-patch validation. It is intentionally a presentation contract,
// not a substitute for the deterministic report and review gates.
const reportArtifactTemplatePolicy = `Write answer_markdown as a decision-ready, highly structured AetherOps research report, not as a chat reply or a dump of internal files. Use this semantic order and structural guidelines:
1. 한눈에 보는 결론 (Executive Summary): Begin with a direct, conclusive answer in 2-4 sentences placed in a blockquote (> **핵심 결론:** ...). Immediately follow with 3-5 decisive findings as bullet points with bold prefixes (e.g., - **발견 1:** ...). When helpful, include a concise decision-readiness table summarizing decision status, evidence strength, and immediate action.
2. 연구 질문과 범위 (Research Scope & Criteria): State the decision question clearly under a dedicated subheading. Separate included scope and excluded scope using a distinct contrast table or structured bullet lists. Define concrete, verifiable acceptance criteria.
3. 방법과 근거 (Methodology & Evidence Architecture): Explain the research workstreams, source-selection logic, tool or solver use, and independent verification steps across the research lifecycle. Include an evidence composition table (workstream, role, source kind, verification status). Do not expose chain-of-thought.
4. 핵심 결과 (Key Findings & Comparative Analysis): Organize findings logically by claim. For each material claim, follow the structure: claim statement -> quantitative/qualitative result with inline citation marker close to the sentence -> engineering/practical meaning -> boundary conditions or contrary evidence. Use Markdown comparison tables for multi-attribute or multi-candidate evaluations, always specifying units and operating points.
5. 공학 해석 (Engineering Interpretation - Conditional): Include only when verified engineering results exist. State the analyzed subject, operating and numerical conditions, solver/version, convergence or stability evidence, sensitivity or independence checks, quantitative results with units, and whether the scientific conclusion is confirmed or inconclusive. Never equate a completed calculation with a confirmed conclusion.
6. 결론 및 권고 (Conclusions & Actionable Recommendations): Provide the recommended strategic decision in a callout box. Include a prioritized action table (우선순위, 실행 과제, 완료 조건, 의존성 및 리스크). Explicitly declare the conditions under which recommendations hold, along with clear stop or escalation criteria.
7. 한계와 불확실성 (Limitations & Uncertainties): Systematically categorize and detail: (1) 자료 한계 (source/sample limitations), (2) 방법론 한계 (method/tool limitations), (3) 결론 민감도 (sensitivity to condition changes), (4) 남은 질문 (unresolved research questions). Every item in uncertainties must be represented here without understatement.
8. 출처 (Verified Sources): Provide a clean, human-readable source list corresponding exactly to the inline citation markers ([1], [2], etc.) with title, publisher/author, date, and verified reference/URL. Do not invent bibliographic fields that are absent from evidence.
Omit only the conditional engineering section when no verified engineering result exists; do not emit empty sections. Keep the answer concise enough to scan, use Markdown tables only for genuinely comparable values, place units and conditions next to numbers, and prefer human-readable artifact names. Keep hashes, raw artifact IDs, thread IDs, turn IDs, and storage paths out of the narrative unless they are themselves necessary findings; the UI exposes audit metadata separately. Do not add claims solely to make the template look complete.`
