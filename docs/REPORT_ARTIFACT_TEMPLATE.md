# AetherOps report artifact template

Version: `aetherops_report_v1`

This contract defines the human-facing structure of an adopted AetherOps research report. It does not replace `ReportManifest`, evidence readback, engineering receipts, the knowledge patch, or the automatic review gate.

## Narrative order

1. **한눈에 보는 결론 (Executive Summary)** — Direct conclusive answer (callout block `> **핵심 결론:** ...`), 3~5 decisive findings with bold prefixes, and quick decision-readiness table.
2. **연구 질문과 범위 (Scope & Objectives)** — Decision question, included scope vs. excluded scope contrast table, and verifiable acceptance criteria.
3. **방법과 근거 (Methodology & Evidence Architecture)** — 4-stage lifecycle (Plan-Collect-Synthesize-Review), source-selection logic, solver/tool execution, and evidence composition table.
4. **핵심 결과 (Key Findings & Comparative Analysis)** — Organized by claim: statement → evidence with inline citation marker `[1]` → impact/meaning → boundary conditions and contrary evidence. Multi-candidate comparison tables with units.
5. **공학 해석 (Engineering Interpretation - Conditional)** — Analyzed subject, operating conditions, numerical setup, convergence residuals, mesh/panel sensitivity, quantitative metrics, and conclusion status.
6. **결론 및 권고 (Conclusions & Actionable Recommendations)** — Recommended decision callout, 4-column prioritized action table (`우선순위 | 실행 과제 | 완료 조건/목표치 | 의존성 및 리스크`), and stop/escalation criteria.
7. **한계와 불확실성 (Limitations & Uncertainties)** — 4-dimension classification: data limitations, methodological limitations, conclusion sensitivity, and unresolved questions.
8. **출처 (Verified References)** — Human-readable standard bibliographic entries corresponding 1:1 to inline citation markers `[1]`, `[2]`, etc.

Headings may be localized to the report language. The semantic order stays fixed, and empty sections are not emitted.

## Data binding

| Visible report element | Authoritative field or artifact |
|---|---|
| Cover title | `ReportManifest.title` |
| Narrative sections | `ReportManifest.answer_markdown` |
| Inline markers and source list | `ReportManifest.citations` plus adopted evidence |
| Limitations | `ReportManifest.uncertainties` and supported narrative |
| Engineering status | `engineering_assessment` and deterministic solver appendix |
| Knowledge adoption summary | validated `knowledge_patch` and active generation receipt |
| Review scorecard | adopted `ReviewVerdict` |
| Audit appendix | run profile, stage attempts, CAS artifacts, solver receipts, and RDF snapshot |

The narrative uses human-readable artifact names. Hashes, storage paths, thread IDs, and turn IDs belong in the audit appendix or inspector, not the main conclusions.

## Visual reference

The canonical Word reference is `docs/templates/AetherOps_Research_Report_Template.docx`. It uses the `standard_business_brief` document preset with one named AetherOps brand override:

- Calibri for Latin text and Malgun Gothic for Korean text.
- Letter portrait, 1 inch margins, 6.5 inch content width.
- Deep blue hierarchy (`#16334B`), mint accent (`#55D8AE`, `#257862`), restrained pale fills (`#EAF9F4`, `#EAF7FC`, `#F7F9FA`).
- Fixed-width tables with explicit DXA geometry (9360 dxa).
- A cover, scan-first conclusion page, research body, conditional engineering section, and audit appendix.

Reference identity and fidelity contract:

- SHA-256: `206e5480ecadbd8211d99d90d1d2a394c58ded38f0250d05ff8f7da4adb3cfb9`
- Size: 266,151 bytes; 8-page reference render; one Letter-portrait section.
- Editable slots: cover title, project, run, conversation session, issue time, cover issue note, report body, and generated audit appendix.
- Preserve-only parts: styles, numbering, theme, logo/media, relationships, headers and footers apart from the project-name text slot, page geometry, and recurring page furniture.
- The renderer clones the reference package. It does not rebuild a generic DOCX or replace the reference visual system.

The reference contains instructional placeholders. A generated report replaces them with verified content and removes any section that does not apply.

## Content rules

- Lead with the answer; do not imitate a chat transcript.
- Put citation markers next to supported claims, not at the end of an unrelated paragraph.
- Put units and operating conditions next to every material numerical result.
- Distinguish calculation completion, numerical convergence, and scientific conclusion.
- Show contrary evidence and disputed results with both sides.
- Do not expose chain-of-thought or intermediate reasoning traces.
- Do not invent content to fill a section.
- Do not use raw filenames as user-facing artifact titles when a human-readable label is available.

## Application issuance contract

1. MERGE or REVISE publishes the canonical JSON `ReportManifest` as `research.report` or `research.report.revision`.
2. REVIEW must pass the existing citation, knowledge-integrity, critical-error, score, and engineering-report gates.
3. The Go core renders `ReportManifest.answer_markdown` and the adopted `ReviewVerdict` into the embedded reference template. Supported document structures include headings, paragraphs, real numbered/bulleted list styles, callouts, fenced code, and explicit fixed-width tables.
4. The rendered package is written to CAS and read back by SHA-256.
5. One SQLite transaction keeps the JSON report as `runs.report_artifact_id`, adds the DOCX as adopted `research.report.document`, adopts evidence, transitions the run to `succeeded`, and invalidates the knowledge projection head.
6. The artifact API serves the document as `application/vnd.openxmlformats-officedocument.wordprocessingml.document` with a `.docx` filename and CAS hash header. The UI verifies that hash before enabling the Word download.

No DOCX is adopted for `quality_failed`, failed, cancelled, interrupted, or uncertain runs. The Word document is a human-facing companion; the structured JSON report remains the authority for RAG and knowledge-graph materialization.
