from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Flowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
RENDER_DIR = ROOT / "tmp" / "pdfs" / "AetherOps_v2_build_validation_report"
PDF_PATH = OUTPUT_DIR / "AetherOps_v2_build_validation_report.pdf"
EVIDENCE_PATH = OUTPUT_DIR / "AetherOps_v2_build_validation_report_evidence.json"

BUILD_SHA256 = "f5066b6c80cf815974642137f0b1d01ebf617c79e21e8ffa490df46e48799b06"
RUNTIME_MANIFEST_SHA256 = "3ba3fa62db8bebd0f2c531808165baad1af5f8e4c3252fe8b037f702ea6e5317"
SIDECAR_TREE_SHA256 = "10ec5ce43b26da83bb5a9b0ab8f58ea843929d85b141b3aeaf6daa537454bad7"

INK = colors.HexColor("#1D2329")
MUTED = colors.HexColor("#66717C")
LINE = colors.HexColor("#D9DEE3")
PANEL = colors.HexColor("#F4F6F7")
ACCENT = colors.HexColor("#267A68")
ACCENT_LIGHT = colors.HexColor("#DCEDE8")
ORANGE = colors.HexColor("#C66A2B")
ORANGE_LIGHT = colors.HexColor("#F6E7DC")
RED = colors.HexColor("#9A3B3B")
RED_LIGHT = colors.HexColor("#F3DEDE")
BLUE = colors.HexColor("#3F6388")


RUNS = [
    {
        "group": "기준 시험",
        "name": "XFOIL 60셀 공력 매트릭스",
        "run_id": "run_f33a42b87107df8bbda003e4714394dd",
        "status": "부분 성공",
        "evidence": "60개 계획, 48 성공, 12 실패",
        "finding": "LLM은 60셀 계획을 구성했지만 -4도 플랩 12셀이 transition 위치 1.0001 파싱 경계에서 실패했다. 파서는 이후 허용 오차와 clamp로 수정됐다.",
    },
    {
        "group": "검증 가설",
        "name": "SQLite WAL 대 PostgreSQL",
        "run_id": "run_e7c120806ac4409a10ca2a1d41743528",
        "status": "실패",
        "evidence": "초기 REVIEW 평균 3.33/5, revision cycle 1",
        "finding": "리뷰는 누락된 백업, 감사, 마이그레이션 기준을 정확히 지적했지만 수정본 citation [8]의 source/claim ID 누락을 복구하지 못했다.",
    },
    {
        "group": "검증 가설",
        "name": "2027년 농촌 5G 완전 대체 주장",
        "run_id": "run_db3837f431e14c9bada67b585724a291",
        "status": "성공",
        "evidence": "REVIEW 평균 4.50/5, 인용 무결성 100%",
        "finding": "완전 대체를 사실로 단정하지 않고 지상 5G 유지, 위성 실증, NTN 보완 방향을 구분해 '자료 부족, 부분 보완만 개연적'으로 결론냈다.",
    },
    {
        "group": "검증 가설",
        "name": "미지원 custom airfoil + OpenFOAM LES",
        "run_id": "run_ebcdb495edcb75e013bfd05b543a3454",
        "status": "안전 차단",
        "evidence": "계획 단계 fail-closed, solver job 0",
        "finding": "preflight 스킬을 제안하고 활성화했지만 실제 capability가 없음을 구분했다. NACA/XFOIL 대체 실행이나 허위 결과 없이 종료했다.",
    },
    {
        "group": "신규 연구",
        "name": "저 Reynolds 천이 민감도 6점",
        "run_id": "run_bf6b6e846cce0939740203e8fc736a5d",
        "status": "불합격",
        "evidence": "정확히 6개 계획, solver job 1 성공, 5개 누락",
        "finding": "첫 셀은 계획과 일치해 실행됐지만 COLLECT가 나머지 5셀을 호출하지 않고 결과를 제출했다. Go 검증기가 누락 셀을 탐지해 uncertain으로 차단했다.",
    },
    {
        "group": "신규 연구",
        "name": "Hybrid RAG + 온톨로지 지식그래프",
        "run_id": "run_a7b8845a19bd84c0627308bc4e8e1ace",
        "status": "성공",
        "evidence": "REVIEW 평균 4.00/5, 인용 14건, 무결성 100%",
        "finding": "그래프를 보편적 업그레이드로 보지 않고 다중 홉, 시간, qualifier, 충돌 과업에 조건부 라우팅하며 동일조건 A/B 중단 기준을 두라고 결론냈다.",
    },
    {
        "group": "신규 연구",
        "name": "WebView2 + loopback CDP 위협 모델",
        "run_id": "run_54d1411984a2c45ab9c78ae8fac4f82d",
        "status": "성공",
        "evidence": "1회 수정 후 REVIEW 평균 4.50/5, 무결성 100%",
        "finding": "별도 UDF와 무작위 포트는 보안 경계가 아니며, 강제 프록시, 송신 차단, bridge 부재, CDP 수명주기, 업로드/다운로드 승인을 P0로 정의했다.",
    },
]


REVIEWS = [
    ("SQLite/PostgreSQL 초기본", 3.33, "미통과"),
    ("농촌 5G 사실 검증", 4.50, "통과"),
    ("RAG/지식그래프", 4.00, "통과"),
    ("WebView2/CDP 수정본", 4.50, "통과"),
]


class ScoreBars(Flowable):
    def __init__(self, rows: list[tuple[str, float, str]], width: float = 168 * mm):
        super().__init__()
        self.rows = rows
        self.width = width
        self.height = 12 * mm + len(rows) * 13 * mm

    def draw(self) -> None:
        canvas = self.canv
        left = 51 * mm
        bar_width = self.width - left - 17 * mm
        y = self.height - 10 * mm
        canvas.setFont("Malgun", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(left, y + 3 * mm, "독립 REVIEW 평균 점수 (1-5)")
        y -= 8 * mm
        for label, value, status in self.rows:
            canvas.setFillColor(INK)
            canvas.setFont("Malgun", 8.2)
            canvas.drawRightString(left - 3 * mm, y + 1.3 * mm, label)
            canvas.setFillColor(colors.HexColor("#E4E8EB"))
            canvas.roundRect(left, y, bar_width, 5 * mm, 2.5 * mm, fill=1, stroke=0)
            canvas.setFillColor(ACCENT if status == "통과" else ORANGE)
            canvas.roundRect(left, y, bar_width * value / 5.0, 5 * mm, 2.5 * mm, fill=1, stroke=0)
            canvas.setFillColor(INK)
            canvas.setFont("MalgunBold", 8.3)
            canvas.drawString(left + bar_width + 3 * mm, y + 1.2 * mm, f"{value:.2f}")
            y -= 13 * mm


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("Malgun", r"C:\Windows\Fonts\malgun.ttf"))
    pdfmetrics.registerFont(TTFont("MalgunBold", r"C:\Windows\Fonts\malgunbd.ttf"))


def p(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(text, style)


def status_style(status: str) -> tuple[colors.Color, colors.Color]:
    if status in {"성공", "안전 차단"}:
        return ACCENT, ACCENT_LIGHT
    if status == "부분 성공":
        return ORANGE, ORANGE_LIGHT
    return RED, RED_LIGHT


def on_page(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 286 * mm, 192 * mm, 286 * mm)
    canvas.setFont("Malgun", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 289 * mm, "AetherOps - 실제 연구 품질 검증")
    canvas.drawRightString(192 * mm, 10 * mm, f"{doc.page}")
    canvas.drawString(18 * mm, 10 * mm, "Build f5066b6c80cf - 2026-08-21 KST")
    canvas.restoreState()


def build_pdf() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    register_fonts()

    base = getSampleStyleSheet()
    styles = {
        "title": ParagraphStyle(
            "TitleK", parent=base["Title"], fontName="MalgunBold", fontSize=23,
            leading=30, textColor=INK, alignment=TA_LEFT, spaceAfter=8 * mm,
        ),
        "subtitle": ParagraphStyle(
            "SubtitleK", parent=base["Normal"], fontName="Malgun", fontSize=10.2,
            leading=16, textColor=MUTED, spaceAfter=8 * mm,
        ),
        "h1": ParagraphStyle(
            "H1K", parent=base["Heading1"], fontName="MalgunBold", fontSize=15.5,
            leading=21, textColor=INK, spaceBefore=6 * mm, spaceAfter=4 * mm,
        ),
        "h2": ParagraphStyle(
            "H2K", parent=base["Heading2"], fontName="MalgunBold", fontSize=11.5,
            leading=16, textColor=INK, spaceBefore=4 * mm, spaceAfter=2.5 * mm,
        ),
        "body": ParagraphStyle(
            "BodyK", parent=base["BodyText"], fontName="Malgun", fontSize=9.2,
            leading=15, textColor=INK, spaceAfter=3 * mm, wordWrap="CJK",
        ),
        "small": ParagraphStyle(
            "SmallK", parent=base["BodyText"], fontName="Malgun", fontSize=7.8,
            leading=11.5, textColor=MUTED, wordWrap="CJK",
        ),
        "callout": ParagraphStyle(
            "CalloutK", parent=base["BodyText"], fontName="MalgunBold", fontSize=11,
            leading=17, textColor=INK, leftIndent=5 * mm, rightIndent=5 * mm,
            spaceBefore=3 * mm, spaceAfter=3 * mm, wordWrap="CJK",
        ),
        "bullet": ParagraphStyle(
            "BulletK", parent=base["BodyText"], fontName="Malgun", fontSize=9,
            leading=14.5, textColor=INK, leftIndent=5 * mm, firstLineIndent=-3 * mm,
            bulletIndent=0, spaceAfter=1.8 * mm, wordWrap="CJK",
        ),
        "table": ParagraphStyle(
            "TableK", parent=base["BodyText"], fontName="Malgun", fontSize=7.1,
            leading=10.2, textColor=INK, wordWrap="CJK",
        ),
        "table_head": ParagraphStyle(
            "TableHeadK", parent=base["BodyText"], fontName="MalgunBold", fontSize=7.2,
            leading=10.5, textColor=colors.white, wordWrap="CJK",
        ),
    }

    doc = SimpleDocTemplate(
        str(PDF_PATH), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=17 * mm, bottomMargin=17 * mm, title="AetherOps 실제 연구 품질 검증 보고서",
        author="Codex", subject="AetherOps build validation",
    )
    story: list = []

    story.append(Spacer(1, 12 * mm))
    story.append(p("AetherOps 실제 연구 품질 검증", styles["title"]))
    story.append(p(
        "Build 0.1.0-alpha.1 | Windows 11 x64 | 실제 ChatGPT OAuth, 실제 모델, 실제 XFOIL, "
        "CAS/SQLite readback | 평가 시각 2026-08-21 KST", styles["subtitle"]
    ))

    verdict_data = [[
        p("현재 빌드 판정", styles["table_head"]),
        p("연구 품질: 조건부 유효 / 릴리스 준비: 불합격", styles["table_head"]),
    ], [
        p("핵심 이유", styles["table"]),
        p(
            "근거 중심 일반 연구와 보안 위협모델은 품질 게이트를 통과했고, 미지원 도구는 안전하게 차단했다. "
            "그러나 공학 매트릭스의 계획-실행 완전성과 revise JSON 복구가 실제 실행에서 실패했다.", styles["table"]
        ),
    ]]
    verdict_table = Table(verdict_data, colWidths=[34 * mm, 132 * mm])
    verdict_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("BACKGROUND", (0, 1), (-1, 1), PANEL),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5 * mm),
    ]))
    story.append(verdict_table)

    story.append(p("기술 요약", styles["h1"]))
    for item in [
        "<b>일반 연구 품질은 유효했다.</b> 농촌 5G 사실 검증은 평균 4.50/5, RAG/지식그래프 연구는 4.00/5, WebView2/CDP 위협모델은 1회 수정 후 4.50/5로 통과했다.",
        "<b>안전 경계는 대체로 강했다.</b> 미지원 custom airfoil + OpenFOAM LES 요청은 preflight 스킬을 만들었지만 실제 실행 능력과 구분했고, 임의 NACA/XFOIL 대체 없이 fail-closed 종료했다.",
        "<b>공학 오케스트레이션은 아직 불합격이다.</b> 60셀 기준 시험은 48/60만 성공했고, 신규 6셀 연구는 첫 셀 이후 5셀을 누락했다. 둘 다 최종 보고서로 승격되지 않았다.",
        "<b>자동 수정은 취약하다.</b> 보안 연구의 revise는 통과했지만 SQLite/PostgreSQL 연구는 citation 배열의 source/claim ID 누락 한 건으로 전체 실행이 failed가 됐다.",
    ]:
        story.append(p("• " + item, styles["bullet"]))

    story.append(p("독립 리뷰 점수는 일반 연구에서 통과했지만 공학 실행 완전성을 대체하지 못한다", styles["h1"]))
    story.append(p(
        "아래 점수는 각 보고서의 과업 충족도, 주장 근거, 출처 품질, 완전성, 추론/불확실성, 명료성/재현성의 산술 평균이다. "
        "통과 기준은 평균 4.0 이상, 모든 축 3 이상, 인용 무결성 100%, 치명 오류 0건이다.", styles["body"]
    ))
    story.append(ScoreBars(REVIEWS))
    story.append(Spacer(1, 3 * mm))

    score_rows = [[
        p("연구", styles["table_head"]), p("평균", styles["table_head"]),
        p("인용", styles["table_head"]), p("지식 근거", styles["table_head"]),
        p("판정", styles["table_head"]),
    ],
        [p("SQLite/PostgreSQL 초기본", styles["table"]), "3.33", "100%", "100% / 미지원 주장 0", "수정 요구"],
        [p("농촌 5G 사실 검증", styles["table"]), "4.50", "100%", "100% / 미지원 주장 0", "통과"],
        [p("RAG/지식그래프", styles["table"]), "4.00", "100%", "100% / 미지원 주장 0", "통과"],
        [p("WebView2/CDP 수정본", styles["table"]), "4.50", "100%", "100% / 미지원 주장 0", "통과"],
    ]
    score_table = Table(score_rows, colWidths=[58 * mm, 17 * mm, 19 * mm, 45 * mm, 25 * mm], repeatRows=1)
    score_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (1, 1), (-1, -1), "Malgun"),
        ("FONTSIZE", (1, 1), (-1, -1), 7.3),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    story.append(score_table)

    story.append(PageBreak())
    story.append(p("무엇을 실제로 측정했는가", styles["h1"]))
    story.append(p(
        "평가 단위는 하나의 AetherOps run이다. 상태는 SQLite runs 행을 권위로 삼았고, 보고서와 리뷰는 CAS artifact API로 readback했다. "
        "공학 실행 수는 engineering_jobs를 읽어 확인했다. 모델 출력의 성공 문구만으로 성공을 판정하지 않았다.", styles["body"]
    ))
    definitions = [
        ("성공", "최종 run 상태 succeeded이며 독립 REVIEW가 모든 자동 품질 조건을 통과"),
        ("안전 차단", "사용자 요구를 임의 축소하거나 허위 실행하지 않고 지원 범위 밖에서 fail-closed"),
        ("불합격", "요구된 연구 범위나 공학 매트릭스를 완료하지 못했거나 최종 품질 산출물이 없음"),
        ("uncertain", "외부 부작용 경계를 지난 뒤 결과의 완전성이 보장되지 않아 자동 재전송을 금지한 상태"),
        ("인용/지식 무결성", "등록 source/claim ID와 KnowledgePatch evidence handle의 구조 검증 결과"),
    ]
    def_rows = [[p("정의", styles["table_head"]), p("판정 기준", styles["table_head"])]] + [
        [p(a, styles["table"]), p(b, styles["table"])] for a, b in definitions
    ]
    def_table = Table(def_rows, colWidths=[32 * mm, 134 * mm], repeatRows=1)
    def_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    story.append(def_table)

    story.append(p("검증 방법", styles["h1"]))
    for item in [
        "일상적인 한국어 질문으로 프로젝트와 대화 세션을 만들고 실제 gpt-5.6-sol/xhigh PLAN, gpt-5.6-terra/high COLLECT, gpt-5.6-sol/xhigh SYNTHESIZE/REVIEW를 실행했다.",
        "연구 전역 동시 실행은 최대 2개, 각 연구의 수집기는 최대 3개로 제한된 실제 제품 경로를 사용했다.",
        "도구 승인은 plan artifact와 arguments JSON을 대조했다. 계획 밖 XFOIL 셀은 승인하지 않았다.",
        "비정상 종료 후 동일 데이터 루트로 재시작해 turn ID가 확정되지 않은 PLAN이 interrupted로 분류되고 명시적 resume 후 재개되는지 확인했다.",
        "ChatGPT Pro는 공학, 방법론, 보안의 세 주제 조합과 판정 기준을 독립 비평했다. Pro 대화 URL은 감사 부록에 기록했다.",
    ]:
        story.append(p("• " + item, styles["bullet"]))

    story.append(p("전체 실행 결과", styles["h1"]))
    rows = [[
        p("구분", styles["table_head"]), p("시험", styles["table_head"]),
        p("판정", styles["table_head"]), p("핵심 증거", styles["table_head"]),
    ]]
    for run in RUNS:
        rows.append([
            p(run["group"], styles["table"]),
            p(run["name"], styles["table"]),
            p(run["status"], styles["table"]),
            p(run["evidence"], styles["table"]),
        ])
    result_table = Table(rows, colWidths=[23 * mm, 55 * mm, 24 * mm, 64 * mm], repeatRows=1)
    table_commands = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]
    for index, run in enumerate(RUNS, start=1):
        fg, bg = status_style(run["status"])
        table_commands.extend([
            ("BACKGROUND", (2, index), (2, index), bg),
            ("TEXTCOLOR", (2, index), (2, index), fg),
        ])
    result_table.setStyle(TableStyle(table_commands))
    story.append(result_table)

    story.append(PageBreak())
    story.append(p("신규 연구 1 - 공력 주제는 안전했지만 완결되지 않았다", styles["h1"]))
    story.append(p(
        "최종 bounded 질문은 NACA 2412, Re=200,000, Mach 0.05, Ncrit 9/3, 목표 CL 0.4/0.6/0.8의 정확히 6개 운용점이었다. "
        "PLAN은 정확했고 첫 XFOIL 요청도 계획과 일치했다. 그러나 COLLECT는 한 셀만 실행한 뒤 나머지 5개 없이 EvidenceBundle을 제출했다. "
        "Go 코어는 ncrit9_cl0p6 셀 누락을 탐지해 결과 채택과 보고서 생성을 차단했다.", styles["body"]
    ))
    for item in [
        "합격한 부분: 계획 밖 셀 자동 승인 없음, raw solver 결과 1건 보존, 불완전 매트릭스의 보고서 승격 차단.",
        "실패한 부분: collector가 선언된 6셀을 완주하지 않음, 누락 후 동일 턴에서 복구하지 않음, 유용한 최종 공력 결론 없음.",
        "이전 60셀 기준 시험도 48/60에 그쳤다. 서로 다른 원인이지만 공학 실행의 end-to-end 완전성은 반복해서 깨졌다.",
    ]:
        story.append(p("• " + item, styles["bullet"]))

    story.append(p("신규 연구 2 - 지식그래프는 과업 조건이 맞을 때만 가치가 있다", styles["h1"]))
    story.append(p(
        "보고서는 GraphRAG를 lexical+vector hybrid RAG의 보편적 대체로 보지 않았다. 반복 엔티티를 여러 문서에서 연결하는 다중 홉 조사, "
        "시간/qualifier 질의, 상충 근거를 양쪽 모두 회수해야 하는 과업에는 그래프 경로를 파일럿할 가치가 있다고 판단했다. 단일 사실 조회, "
        "변경이 빠른 소규모 코퍼스, 엔티티 연결이 불안정한 영역은 기본 hybrid를 유지해야 한다.", styles["body"]
    ))
    story.append(p(
        "측정 권고는 동일 corpus, generator, prompt, reranker, 토큰 예산에서 retrieval profile만 바꾸는 paired A/B다. 공개 근거만으로 보편적인 개선률을 "
        "주장하지 않았고, +2%p 하한, entity-linking precision, path precision, latency, 비용을 프로젝트 guardrail로 명시했다. 이 수치는 보편 법칙이 아니라 "
        "사전등록용 중단 기준이라는 caveat가 붙었다.", styles["body"]
    ))

    story.append(p("신규 연구 3 - WebView2/CDP 설계는 UDF와 무작위 포트만으로 안전하지 않다", styles["h1"]))
    story.append(p(
        "최종 수정본은 별도 UDF가 저장소 오염을 줄일 뿐 OS 보안 경계가 아니며, loopback 무작위 CDP 포트도 인증이 아니라고 결론냈다. "
        "셸 CDP 부재, 인터넷 네이티브 bridge 부재, 정책 프록시와 직접 송신 차단, DNS rebinding/사설망 차단, 업로드와 다운로드 승인, "
        "수동-자동 전환 epoch 검증을 P0로 분류했다.", styles["body"]
    ))
    story.append(p(
        "초기 리뷰는 인용 무결성 82%와 세 가지 치명 오류를 발견했다. 수정본은 프로세스별 송신 집행점, 공격 경로별 전제/실패/탐지/재현 시험, "
        "포트 고유성이 아닌 loopback-only 소유 PID와 종료 후 폐쇄 기준을 보강해 평균 4.50/5, 인용 무결성 100%로 통과했다.", styles["body"]
    ))

    story.append(PageBreak())
    story.append(p("강건성 점검과 회귀시험", styles["h1"]))
    regression_rows = [
        ("Frontend", "node --test", "24/24 통과"),
        ("Knowledge sidecar", "실제 Oxigraph node tests", "10/10 통과"),
        ("Go packages", "go test ./...", "desktop 외 모든 패키지 통과"),
        ("Desktop Gate 0", "단독 실제 트레이/WebView2", "통과"),
        ("Static analysis", "go vet ./...", "통과"),
        ("Frontend types", "tsc --noEmit", "통과"),
        ("Restart recovery", "강제 종료 후 동일 DB 재기동", "interrupted로 fail-closed 후 명시적 resume 성공"),
    ]
    rr = [[p("표면", styles["table_head"]), p("방법", styles["table_head"]), p("결과", styles["table_head"])]] + [
        [p(a, styles["table"]), p(b, styles["table"]), p(c, styles["table"])] for a, b, c in regression_rows
    ]
    rt = Table(rr, colWidths=[40 * mm, 62 * mm, 64 * mm], repeatRows=1)
    rt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    story.append(rt)
    story.append(Spacer(1, 3 * mm))
    story.append(p(
        "첫 전체 Go 실행의 desktop 시험은 당시 살아 있던 평가 앱과 Windows tray 자원을 경쟁해 Shell_NotifyIconW에서 실패했다. 평가 앱을 종료한 뒤 같은 테스트를 "
        "단독 실제 데스크톱 권한으로 재실행해 통과했다. 따라서 코드 회귀로 보지는 않지만, 병렬 GUI 시험 격리는 CI에 명시할 필요가 있다.", styles["small"]
    ))

    story.append(p("현재 빌드의 결정적 결함", styles["h1"]))
    defect_rows = [
        ("P0", "공학 matrix 완전성", "계획된 다중 셀을 collector가 전부 실행하지 않아도 모델 턴 자체는 종료된다. 코어가 사후 차단하지만 연구는 완성되지 않는다."),
        ("P1", "revise 구조 복구", "품질 리뷰가 적절해도 수정본의 citation ID 한 건이 잘못되면 실행 전체가 failed가 된다. 같은 cycle의 제한적 schema-repair 경로가 없다."),
        ("P1", "승인 거절 반복", "계획 밖 XFOIL 셀을 거절한 뒤 collector가 동일 또는 다른 비계획 셀 승인을 반복 요청했다. 첫 denial에서 해당 workstream을 중단해야 한다."),
        ("P1", "App Server turn 정리", "취소된 PLAN 뒤 새 PLAN이 외부 turn ID 없이 장시간 정체됐다. 프로세스 재시작 후 recovery는 안전했지만 턴 취소/stdio 해제가 부족하다."),
        ("P2", "실행 증거의 제품화", "좋은 보안 연구도 현재 빌드 적합성 인증이 아니라 설계 위협모델에 머문다. Gate 0 실제 socket, ACL, Job, proxy receipt가 필요하다."),
    ]
    dr = [[p("우선", styles["table_head"]), p("영역", styles["table_head"]), p("관찰과 영향", styles["table_head"])]] + [
        [p(a, styles["table"]), p(b, styles["table"]), p(c, styles["table"])] for a, b, c in defect_rows
    ]
    dt = Table(dr, colWidths=[17 * mm, 42 * mm, 107 * mm], repeatRows=1)
    dt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TEXTCOLOR", (0, 1), (0, 1), RED),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
    ]))
    story.append(dt)

    story.append(p("권고 우선순위", styles["h1"]))
    recommendations = [
        "공학 collector가 각 tool call을 자유롭게 선택하게 두지 말고, 승인된 matrix를 Go가 직접 job queue로 materialize해 exact-once 실행한다. 모델은 결과 해석만 맡긴다.",
        "revise 출력의 schema/참조 무결성 오류는 외부 부작용이 없는 같은 cycle에서 원본 evidence와 고정 피드백으로 최대 1-2회 제한 재생한다. 일반 품질 수정 횟수와 분리한다.",
        "첫 tool denial 또는 계획 밖 call에서 collector turn을 중단하고 run을 failed/quality_failed로 수렴시킨다. 동일 승인 반복은 허용하지 않는다.",
        "취소 시 App Server turn cancel acknowledgement와 stdio drain을 기다리고, 일정 시간 내 해제되지 않으면 런타임을 격리 재시작한다.",
        "위 네 항목과 실제 Gate 0 receipt를 통과하기 전에는 v0.1.0-alpha.1을 연구 릴리스 후보로 승격하지 않는다.",
    ]
    for index, item in enumerate(recommendations, start=1):
        story.append(p(f"{index}. {item}", styles["bullet"]))

    story.append(p("제한과 남은 질문", styles["h1"]))
    for item in [
        "이번 평가는 공식 12건 release evaluation 전체가 아니라 목적별 실사용 run과 세 신규 주제다. clean VM, signed feed, 실제 12/12 품질 게이트를 대체하지 않는다.",
        "성공 보고서의 knowledge_patch는 정확한 byte span handle 부족으로 assertion이 비어 있었다. 지식그래프 채택 품질은 별도 E2E가 필요하다.",
        "공학 주제는 최종 보고서가 없으므로 수치 성능 결론을 내리지 않는다. 실패 자체가 현재 빌드의 품질 판정 근거다.",
        "WebView2/CDP 보고서는 설계 위협모델이다. 실제 빌드의 proxy, WFP, UDF ACL, socket owner, Job membership receipt가 있어야 구현 적합성을 판정할 수 있다.",
    ]:
        story.append(p("• " + item, styles["bullet"]))

    story.append(PageBreak())
    story.append(p("감사 부록 - 식별자와 해시", styles["h1"]))
    meta = [
        ("Executable SHA-256", BUILD_SHA256),
        ("Runtime manifest SHA-256", RUNTIME_MANIFEST_SHA256),
        ("Knowledge sidecar tree SHA-256", SIDECAR_TREE_SHA256),
        ("Pro review conversation", "https://chatgpt.com/g/g-p-6a60ca81c0408191a463f72040905459-codexyong-sesyeon/c/6a7382bf-764c-83e8-a705-df4d2f0e1991"),
    ]
    mr = [[p("항목", styles["table_head"]), p("값", styles["table_head"])]] + [
        [p(a, styles["table"]), p(b, styles["small"])] for a, b in meta
    ]
    mt = Table(mr, colWidths=[48 * mm, 118 * mm], repeatRows=1)
    mt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    story.append(mt)
    story.append(Spacer(1, 4 * mm))

    audit_rows = [[p("구분", styles["table_head"]), p("Run ID", styles["table_head"]), p("최종 상태", styles["table_head"])]]
    for run in RUNS:
        audit_rows.append([p(run["name"], styles["table"]), p(run["run_id"], styles["small"]), p(run["status"], styles["table"])])
    at = Table(audit_rows, colWidths=[66 * mm, 72 * mm, 28 * mm], repeatRows=1)
    at.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PANEL]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    story.append(at)
    story.append(Spacer(1, 5 * mm))
    story.append(p(
        "판정 신뢰도: <b>공유 가능하나 릴리스 결정에는 caveat 필수</b>. DB 상태, CAS artifact, solver job 수와 독립 REVIEW 점수는 재검증했다. "
        "그러나 공식 12/12 release evidence와 clean VM 두 종은 이번 보고서 범위 밖이다.", styles["callout"]
    ))

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)


def write_evidence() -> None:
    payload = {
        "schema": "aetherops_build_validation_report_evidence_v1",
        "as_of": "2026-08-21T12:20:00+09:00",
        "build": {
            "version": "0.1.0-alpha.1",
            "executable_sha256": BUILD_SHA256,
            "runtime_manifest_sha256": RUNTIME_MANIFEST_SHA256,
            "knowledge_sidecar_tree_sha256": SIDECAR_TREE_SHA256,
        },
        "review_scores": [
            {"name": name, "mean": score, "status": status} for name, score, status in REVIEWS
        ],
        "runs": RUNS,
        "regression": {
            "frontend_tests": "24/24 passed",
            "knowledge_sidecar_tests": "10/10 passed",
            "go_packages": "all non-desktop packages passed in full run",
            "desktop_gate0": "passed in isolated real desktop run",
            "go_vet": "passed",
            "frontend_tsc": "passed",
        },
    }
    EVIDENCE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def render_and_verify() -> dict:
    for old in RENDER_DIR.glob("page-*.png"):
        old.unlink()
    pdf = pdfium.PdfDocument(str(PDF_PATH))
    rendered: list[str] = []
    for index in range(len(pdf)):
        page = pdf[index]
        bitmap = page.render(scale=1.65)
        image = bitmap.to_pil()
        path = RENDER_DIR / f"page-{index + 1:02d}.png"
        image.save(path)
        rendered.append(str(path))
    with pdfplumber.open(PDF_PATH) as check:
        text = "\n".join((page.extract_text() or "") for page in check.pages)
        page_count = len(check.pages)
    required = [
        "연구 품질: 조건부 유효 / 릴리스 준비: 불합격",
        "Hybrid RAG + 온톨로지 지식그래프",
        "WebView2 + loopback CDP 위협 모델",
        "저 Reynolds 천이 민감도 6점",
        BUILD_SHA256,
    ]
    missing = [item for item in required if item not in text]
    if missing:
        raise RuntimeError(f"PDF text verification failed; missing {missing}")
    digest = hashlib.sha256(PDF_PATH.read_bytes()).hexdigest()
    return {
        "pdf": str(PDF_PATH),
        "sha256": digest,
        "pages": page_count,
        "rendered_pages": rendered,
        "evidence": str(EVIDENCE_PATH),
        "text_characters": len(text),
    }


def main() -> None:
    build_pdf()
    write_evidence()
    print(json.dumps(render_and_verify(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
