// Package reportdocx renders a reviewed ReportManifest into the embedded
// AetherOps Word template without introducing a second document design system.
package reportdocx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	reporttemplates "github.com/djkim0320/AetherOps/docs/templates"
	"github.com/djkim0320/AetherOps/internal/core"
)

const (
	// TemplateVersion is persisted in prompts and rendered audit metadata.
	TemplateVersion = "aetherops_report_v1"
	// ArtifactKind identifies the human-facing Word companion to the canonical
	// JSON ReportManifest.
	ArtifactKind = "research.report.document"
	// MediaType is the registered MIME type for a DOCX package.
	MediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

const (
	documentPart       = "word/document.xml"
	corePropertiesPart = "docProps/core.xml"
	conclusionMarker   = "한눈에 보는 결론"
	coverUsageText     = "템플릿 안내  ·  꺾쇠 괄호 안의 안내 문구는 실제 연구 내용으로 교체하고, 해당 없는 조건부 장은 제거합니다."
	issuedUsageText    = "AetherOps 품질 게이트를 통과한 최종 연구 보고서입니다."
)

var (
	headingPattern      = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)
	orderedListPattern  = regexp.MustCompile(`^(\d+)[.)]\s+(.+)$`)
	tableDividerPattern = regexp.MustCompile(`^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$`)
	linkPattern         = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
)

// Input binds only already-validated durable values to the presentation
// template. It deliberately excludes prompts and model reasoning traces.
type Input struct {
	Run         core.Run
	Project     core.Project
	Report      core.ReportManifest
	Verdict     core.ReviewVerdict
	GeneratedAt time.Time
}

// Render clones the embedded DOCX package, keeps its styles, numbering,
// relationships, headers, footers and artwork, and replaces only documented
// content slots plus the report body.
func Render(input Input) ([]byte, error) {
	if strings.TrimSpace(input.Project.Name) == "" || strings.TrimSpace(input.Run.ID) == "" ||
		strings.TrimSpace(input.Report.Title) == "" || strings.TrimSpace(input.Report.AnswerMarkdown) == "" {
		return nil, errors.New("report document input is incomplete")
	}
	passes, err := input.Verdict.PassesForReport(input.Report)
	if err != nil {
		return nil, fmt.Errorf("validate report verdict: %w", err)
	}
	if !passes {
		return nil, errors.New("only a quality-passing report can be rendered as an adopted document")
	}
	if input.GeneratedAt.IsZero() {
		input.GeneratedAt = input.Run.UpdatedAt
	}
	if input.GeneratedAt.IsZero() {
		return nil, errors.New("report document generation time is required")
	}
	input.GeneratedAt = input.GeneratedAt.UTC()

	reader, err := zip.NewReader(bytes.NewReader(reporttemplates.AetherOpsResearchReportTemplate), int64(len(reporttemplates.AetherOpsResearchReportTemplate)))
	if err != nil {
		return nil, fmt.Errorf("open embedded report template: %w", err)
	}
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	foundDocument := false
	for _, file := range reader.File {
		contents, err := readZipFile(file)
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("read template part %s: %w", file.Name, err)
		}
		switch {
		case file.Name == documentPart:
			foundDocument = true
			contents, err = renderDocumentXML(contents, input)
		case file.Name == corePropertiesPart:
			contents = renderCoreProperties(contents, input)
		case strings.HasPrefix(file.Name, "word/header") && strings.HasSuffix(file.Name, ".xml"):
			contents = replaceLiteralXMLText(contents, "〈프로젝트명〉", input.Project.Name)
		}
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("render template part %s: %w", file.Name, err)
		}
		header := file.FileHeader
		part, err := writer.CreateHeader(&header)
		if err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("create report part %s: %w", file.Name, err)
		}
		if _, err := part.Write(contents); err != nil {
			_ = writer.Close()
			return nil, fmt.Errorf("write report part %s: %w", file.Name, err)
		}
	}
	if !foundDocument {
		_ = writer.Close()
		return nil, errors.New("embedded report template has no Word document part")
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("finalize report document: %w", err)
	}
	return output.Bytes(), nil
}

func readZipFile(file *zip.File) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(reader)
}

func renderDocumentXML(source []byte, input Input) ([]byte, error) {
	document := string(source)
	marker := strings.Index(document, conclusionMarker)
	if marker < 0 {
		return nil, errors.New("report template conclusion marker is absent")
	}
	bodyStart := precedingParagraphStart(document, marker)
	sectionStart := strings.LastIndex(document, "<w:sectPr")
	if bodyStart < 0 || sectionStart < 0 || bodyStart >= sectionStart {
		return nil, errors.New("report template body boundaries are invalid")
	}

	prefix := []byte(document[:bodyStart])
	prefix = replaceLiteralXMLText(prefix, "〈연구 제목을 한 문장으로 입력〉", input.Report.Title)
	prefix = replaceLiteralXMLText(prefix, "〈프로젝트명〉", input.Project.Name)
	prefix = replaceLiteralXMLText(prefix, "〈Run ID〉", input.Run.ID)
	session := input.Run.ConversationSessionID
	if strings.TrimSpace(session) == "" {
		session = "일정 실행"
	}
	prefix = replaceLiteralXMLText(prefix, "〈대화 세션〉", session)
	prefix = replaceLiteralXMLText(prefix, "〈완료 일시 / 시간대〉", input.GeneratedAt.Format("2006-01-02 15:04 UTC"))
	prefix = replaceLiteralXMLText(prefix, coverUsageText, issuedUsageText)

	var body strings.Builder
	body.Write(prefix)
	body.WriteString(renderMarkdown(input.Report.AnswerMarkdown))
	body.WriteString(pageBreak())
	body.WriteString(renderAuditAppendix(input))
	body.WriteString(document[sectionStart:])
	result := body.String()
	if strings.Contains(result, "〈") || strings.Contains(result, "〉") {
		return nil, errors.New("rendered report still contains an instructional placeholder")
	}
	return []byte(result), nil
}

func precedingParagraphStart(document string, position int) int {
	search := document[:position]
	for {
		candidate := strings.LastIndex(search, "<w:p")
		if candidate < 0 {
			return -1
		}
		after := candidate + len("<w:p")
		if after < len(document) && (document[after] == '>' || document[after] == ' ') {
			return candidate
		}
		search = search[:candidate]
	}
}

func replaceLiteralXMLText(source []byte, oldText, newText string) []byte {
	escaped := xmlText(newText)
	return bytes.ReplaceAll(source, []byte(oldText), []byte(escaped))
}

func renderCoreProperties(source []byte, input Input) []byte {
	properties := string(source)
	properties = replaceElement(properties, "dc:title", input.Report.Title)
	properties = replaceElement(properties, "dc:subject", "AetherOps 검증 완료 연구 보고서")
	properties = replaceElement(properties, "dc:description", "AetherOps report artifact "+TemplateVersion)
	properties = replaceElement(properties, "dcterms:modified", input.GeneratedAt.Format(time.RFC3339))
	return []byte(properties)
}

func replaceElement(document, element, value string) string {
	pattern := regexp.MustCompile(`(?s)(<` + regexp.QuoteMeta(element) + `(?:\s[^>]*)?>).*?(</` + regexp.QuoteMeta(element) + `>)`)
	return pattern.ReplaceAllString(document, `${1}`+escapeReplacement(xmlText(value))+`${2}`)
}

func escapeReplacement(value string) string {
	return strings.ReplaceAll(value, "$", "$$")
}

func renderMarkdown(markdown string) string {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	var output strings.Builder
	var paragraph []string
	flushParagraph := func() {
		if len(paragraph) == 0 {
			return
		}
		output.WriteString(textParagraph(strings.Join(paragraph, " "), "Normal", ""))
		paragraph = paragraph[:0]
	}

	for index := 0; index < len(lines); {
		line := strings.TrimRight(lines[index], " \t")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			flushParagraph()
			index++
			continue
		}
		if strings.HasPrefix(trimmed, "```") {
			flushParagraph()
			index++
			for index < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[index]), "```") {
				output.WriteString(codeParagraph(lines[index]))
				index++
			}
			if index < len(lines) {
				index++
			}
			continue
		}
		if match := headingPattern.FindStringSubmatch(trimmed); match != nil {
			flushParagraph()
			level := len(match[1])
			if level > 3 {
				level = 3
			}
			output.WriteString(textParagraph(match[2], "Heading"+strconv.Itoa(level), ""))
			index++
			continue
		}
		if index+1 < len(lines) && isTableRow(trimmed) && tableDividerPattern.MatchString(strings.TrimSpace(lines[index+1])) {
			flushParagraph()
			rows := [][]string{splitTableRow(trimmed)}
			index += 2
			for index < len(lines) && isTableRow(strings.TrimSpace(lines[index])) {
				rows = append(rows, splitTableRow(strings.TrimSpace(lines[index])))
				index++
			}
			output.WriteString(wordTable(rows))
			continue
		}
		if strings.HasPrefix(trimmed, ">") {
			flushParagraph()
			quote := strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
			output.WriteString(calloutParagraph(quote))
			index++
			continue
		}
		indent, listText, listStyle, list := parseList(line)
		if list {
			flushParagraph()
			if indent > 0 {
				listStyle += strconv.Itoa(min(indent+1, 3))
			}
			output.WriteString(textParagraph(listText, listStyle, ""))
			index++
			continue
		}
		if trimmed == "---" || trimmed == "***" || trimmed == "___" {
			flushParagraph()
			output.WriteString(horizontalRule())
			index++
			continue
		}
		paragraph = append(paragraph, trimmed)
		index++
	}
	flushParagraph()
	if output.Len() == 0 {
		return textParagraph("보고서 본문이 없습니다.", "Normal", "")
	}
	return output.String()
}

func parseList(line string) (int, string, string, bool) {
	leading := len(line) - len(strings.TrimLeft(line, " \t"))
	indent := leading / 2
	trimmed := strings.TrimSpace(line)
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") {
		return indent, strings.TrimSpace(trimmed[2:]), "ListBullet", true
	}
	if match := orderedListPattern.FindStringSubmatch(trimmed); match != nil {
		return indent, match[2], "ListNumber", true
	}
	return 0, "", "", false
}

func isTableRow(line string) bool {
	return strings.Count(line, "|") >= 2
}

func splitTableRow(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	line = strings.TrimSuffix(line, "|")
	parts := strings.Split(line, "|")
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
	}
	return parts
}

func textParagraph(text, style, extraProperties string) string {
	var output strings.Builder
	output.WriteString("<w:p><w:pPr>")
	if style != "" {
		output.WriteString(`<w:pStyle w:val="` + xmlText(style) + `"/>`)
	}
	output.WriteString(extraProperties)
	output.WriteString("</w:pPr>")
	output.WriteString(inlineRuns(text))
	output.WriteString("</w:p>")
	return output.String()
}

func inlineRuns(text string) string {
	text = linkPattern.ReplaceAllString(text, `$1 ($2)`)
	type styleState struct{ bold, italic, code bool }
	state := styleState{}
	var output strings.Builder
	var buffer strings.Builder
	flush := func() {
		if buffer.Len() == 0 {
			return
		}
		output.WriteString(wordRun(buffer.String(), state))
		buffer.Reset()
	}
	for index := 0; index < len(text); {
		switch {
		case strings.HasPrefix(text[index:], "**"):
			flush()
			state.bold = !state.bold
			index += 2
		case text[index] == '`':
			flush()
			state.code = !state.code
			index++
		case text[index] == '*':
			flush()
			state.italic = !state.italic
			index++
		default:
			r, size := utf8.DecodeRuneInString(text[index:])
			buffer.WriteRune(r)
			index += size
		}
	}
	flush()
	return output.String()
}

func wordRun(text string, style struct{ bold, italic, code bool }) string {
	var properties strings.Builder
	if style.bold || style.italic || style.code {
		properties.WriteString("<w:rPr>")
		if style.code {
			properties.WriteString(`<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Malgun Gothic"/><w:color w:val="334155"/><w:shd w:val="clear" w:color="auto" w:fill="F2F5F6"/>`)
		}
		if style.bold {
			properties.WriteString("<w:b/>")
		}
		if style.italic {
			properties.WriteString("<w:i/>")
		}
		properties.WriteString("</w:rPr>")
	}
	return "<w:r>" + properties.String() + `<w:t xml:space="preserve">` + xmlText(text) + "</w:t></w:r>"
}

func calloutParagraph(text string) string {
	properties := `<w:spacing w:before="140" w:after="220" w:line="276" w:lineRule="auto"/>` +
		`<w:ind w:left="240" w:right="180"/><w:pBdr><w:left w:val="single" w:sz="22" w:space="10" w:color="4BD0A0"/></w:pBdr>` +
		`<w:shd w:val="clear" w:color="auto" w:fill="EAF9F4"/>`
	return textParagraph(text, "Normal", properties)
}

func codeParagraph(text string) string {
	properties := `<w:spacing w:before="0" w:after="0"/><w:ind w:left="180" w:right="180"/><w:shd w:val="clear" w:color="auto" w:fill="F2F5F6"/>`
	state := struct{ bold, italic, code bool }{code: true}
	return "<w:p><w:pPr>" + properties + "</w:pPr>" + wordRun(text, state) + "</w:p>"
}

func horizontalRule() string {
	return `<w:p><w:pPr><w:spacing w:before="100" w:after="180"/><w:pBdr><w:bottom w:val="single" w:sz="5" w:space="4" w:color="CBD5DA"/></w:pBdr></w:pPr></w:p>`
}

func pageBreak() string {
	return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`
}

func wordTable(rows [][]string) string {
	if len(rows) == 0 {
		return ""
	}
	columns := 0
	for _, row := range rows {
		columns = max(columns, len(row))
	}
	if columns == 0 {
		return ""
	}
	for index := range rows {
		for len(rows[index]) < columns {
			rows[index] = append(rows[index], "")
		}
	}
	widths := tableColumnWidths(rows, columns)
	alignments := columnAlignments(rows, columns)
	var output strings.Builder
	output.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblInd w:w="120" w:type="dxa"/><w:tblLayout w:type="fixed"/>`)
	output.WriteString(`<w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>`)
	output.WriteString(`<w:tblBorders><w:top w:val="single" w:sz="5" w:color="CBD5DA"/><w:left w:val="single" w:sz="5" w:color="CBD5DA"/><w:bottom w:val="single" w:sz="5" w:color="CBD5DA"/><w:right w:val="single" w:sz="5" w:color="CBD5DA"/><w:insideH w:val="single" w:sz="4" w:color="DDE4E7"/><w:insideV w:val="single" w:sz="4" w:color="DDE4E7"/></w:tblBorders></w:tblPr><w:tblGrid>`)
	for _, width := range widths {
		output.WriteString(`<w:gridCol w:w="` + strconv.Itoa(width) + `"/>`)
	}
	output.WriteString("</w:tblGrid>")
	for rowIndex, row := range rows {
		output.WriteString("<w:tr>")
		if rowIndex == 0 {
			output.WriteString("<w:trPr><w:tblHeader/></w:trPr>")
		}
		for columnIndex, cell := range row {
			fill := "FFFFFF"
			if rowIndex == 0 {
				fill = "EAF9F4"
			}
			output.WriteString(`<w:tc><w:tcPr><w:tcW w:w="` + strconv.Itoa(widths[columnIndex]) + `" w:type="dxa"/><w:vAlign w:val="center"/><w:shd w:val="clear" w:color="auto" w:fill="` + fill + `"/></w:tcPr>`)
			alignment := alignments[columnIndex]
			bold := rowIndex == 0
			output.WriteString(`<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="` + alignment + `"/></w:pPr>`)
			state := struct{ bold, italic, code bool }{bold: bold}
			output.WriteString(wordRun(strings.TrimSpace(cell), state))
			output.WriteString("</w:p></w:tc>")
		}
		output.WriteString("</w:tr>")
	}
	output.WriteString("</w:tbl><w:p><w:pPr><w:spacing w:after=\"80\"/></w:pPr></w:p>")
	return output.String()
}

func tableColumnWidths(rows [][]string, columns int) []int {
	weights := make([]int, columns)
	for column := range columns {
		weights[column] = 8
		for _, row := range rows {
			length := utf8.RuneCountInString(stripInlineMarkdown(row[column]))
			weights[column] = max(weights[column], min(length, 36))
		}
	}
	const total = 9360
	const minimum = 900
	widths := make([]int, columns)
	if columns*minimum >= total {
		for column := range columns {
			widths[column] = total / columns
		}
		widths[columns-1] += total - sumInts(widths)
		return widths
	}
	remaining := total - columns*minimum
	weightTotal := sumInts(weights)
	for column := range columns {
		widths[column] = minimum + remaining*weights[column]/weightTotal
	}
	widths[columns-1] += total - sumInts(widths)
	return widths
}

var numericCellPattern = regexp.MustCompile(`^[-+]?[0-9]{1,3}(,[0-9]{3})*(\.[0-9]+)?(%|deg|m|s|ms|Pa|kPa|MPa|K|C|dB|x)?$`)

func isNumericCell(value string) bool {
	val := strings.TrimSpace(value)
	if val == "" || val == "-" || val == "N/A" || val == "n/a" {
		return false
	}
	return numericCellPattern.MatchString(val)
}

func columnAlignments(rows [][]string, columns int) []string {
	alignments := make([]string, columns)
	for column := range columns {
		allNumeric := true
		hasData := false
		allShort := true
		for row := 1; row < len(rows); row++ {
			val := strings.TrimSpace(stripInlineMarkdown(rows[row][column]))
			if val == "" {
				continue
			}
			hasData = true
			if !isNumericCell(val) {
				allNumeric = false
			}
			if utf8.RuneCountInString(val) > 14 || strings.Contains(val, ". ") {
				allShort = false
			}
		}
		if hasData && allNumeric {
			alignments[column] = "right"
		} else if allShort {
			alignments[column] = "center"
		} else {
			alignments[column] = "left"
		}
	}
	return alignments
}

func stripInlineMarkdown(value string) string {
	value = linkPattern.ReplaceAllString(value, `$1 ($2)`)
	return strings.NewReplacer("**", "", "*", "", "`", "").Replace(value)
}

func sumInts(values []int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func renderAuditAppendix(input Input) string {
	var output strings.Builder
	output.WriteString(textParagraph("재현성 및 감사 부록", "Heading1", ""))
	output.WriteString(calloutParagraph("이 부록은 사용자 결론과 분리된 실행·품질·지식 채택 감사 정보입니다."))

	output.WriteString(textParagraph("실행 계약", "Heading2", ""))
	executionRows := [][]string{
		{"항목", "검증된 값"},
		{"템플릿", TemplateVersion},
		{"프로젝트", input.Project.Name},
		{"Run ID", input.Run.ID},
		{"대화 세션", valueOr(input.Run.ConversationSessionID, "일정 실행")},
		{"연구 프로필", input.Run.ResearchProfileVersion},
		{"검색 프로필", input.Run.RetrievalProfile},
		{"지식 generation", input.Run.KnowledgeGenerationID},
		{"PLAN / MERGE / REVISE / REVIEW", strings.Join([]string{core.PlannerModel, core.PlannerEffort, core.ServiceTierDefault}, " · ")},
		{"COLLECT", strings.Join([]string{core.CollectorModel, core.CollectorEffort, core.ServiceTierDefault}, " · ")},
		{"제품 버전", input.Run.ProductBuild.Version},
		{"발행 시각", input.GeneratedAt.Format(time.RFC3339)},
	}
	output.WriteString(wordTable(executionRows))

	output.WriteString(pageBreak())
	output.WriteString(textParagraph("품질 리뷰", "Heading2", ""))
	scores := input.Verdict.Scores
	scoreRows := [][]string{
		{"평가 축", "점수"},
		{"과업 충족도", strconv.Itoa(scores.TaskFulfillment)},
		{"주장 근거성", strconv.Itoa(scores.ClaimSupport)},
		{"출처 품질·다양성", strconv.Itoa(scores.SourceQuality)},
		{"반대 근거·완전성", strconv.Itoa(scores.Completeness)},
		{"추론·불확실성", strconv.Itoa(scores.ReasoningAndUncertainty)},
		{"명료성·재현성", strconv.Itoa(scores.ClarityAndReproducibility)},
		{"평균", fmt.Sprintf("%.1f / 5.0", reviewAverage(scores))},
		{"인용 무결성", strconv.Itoa(input.Verdict.CitationIntegrityPercent) + "%"},
		{"치명적 오류", strconv.Itoa(len(input.Verdict.CriticalErrors)) + "건"},
	}
	if input.Verdict.KnowledgeIntegrity != nil {
		scoreRows = append(scoreRows,
			[]string{"지식 근거 무결성", strconv.Itoa(input.Verdict.KnowledgeIntegrity.EvidenceIntegrityPercent) + "%"},
			[]string{"미지원 assertion", strconv.Itoa(input.Verdict.KnowledgeIntegrity.UnsupportedAssertions) + "건"},
		)
	}
	output.WriteString(wordTable(scoreRows))
	output.WriteString(calloutParagraph("최종 판정: 통과. " + strings.TrimSpace(input.Verdict.Summary)))

	output.WriteString(pageBreak())
	output.WriteString(textParagraph("지식그래프 채택 요약", "Heading2", ""))
	aliases := 0
	evidenceHandles := 0
	qualifiers := 0
	for _, entity := range input.Report.KnowledgePatch.Entities {
		aliases += len(entity.Aliases)
	}
	for _, assertion := range input.Report.KnowledgePatch.Assertions {
		evidenceHandles += len(assertion.Evidence)
		qualifiers += len(assertion.Qualifiers)
	}
	output.WriteString(wordTable([][]string{
		{"항목", "수량 / 버전"},
		{"개체", strconv.Itoa(len(input.Report.KnowledgePatch.Entities))},
		{"alias", strconv.Itoa(aliases)},
		{"assertion", strconv.Itoa(len(input.Report.KnowledgePatch.Assertions))},
		{"qualifier", strconv.Itoa(qualifiers)},
		{"근거 handle", strconv.Itoa(evidenceHandles)},
		{"스키마", input.Report.KnowledgePatch.SchemaVersion},
		{"단위 registry", input.Report.KnowledgePatch.UnitRegistryVersion},
	}))

	if len(input.Report.ArtifactHashes) > 0 || input.Run.ProductBuild.ExecutableSHA256 != "" {
		output.WriteString(textParagraph("산출물 무결성", "Heading2", ""))
		hashes := append([]string(nil), input.Report.ArtifactHashes...)
		sort.Strings(hashes)
		for _, hash := range hashes {
			output.WriteString(textParagraph(hash, "ListBullet", ""))
		}
		for _, pair := range []struct{ label, hash string }{
			{"AetherOps 실행 파일", input.Run.ProductBuild.ExecutableSHA256},
			{"런타임 manifest", input.Run.ProductBuild.RuntimeManifestSHA256},
			{"지식 sidecar", input.Run.ProductBuild.KnowledgeSidecarTreeSHA256},
		} {
			if pair.hash != "" {
				output.WriteString(textParagraph(pair.label+": "+pair.hash, "ListBullet", ""))
			}
		}
	}
	return output.String()
}

func reviewAverage(scores core.ReviewScores) float64 {
	values := scores.Values()
	total := 0
	for _, value := range values {
		total += value
	}
	if len(values) == 0 {
		return 0
	}
	return float64(total) / float64(len(values))
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func xmlText(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}
