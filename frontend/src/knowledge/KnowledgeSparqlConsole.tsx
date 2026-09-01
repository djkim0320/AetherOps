import { useState } from "preact/hooks";
import { KNOWLEDGE_MAX_SPARQL_ROWS } from "../knowledge-types";
import {
  compactSparqlTerm,
  describeSparqlTerm,
  normalizeSparqlTableResult
} from "../knowledge-sparql";

export type KnowledgeSparqlConsoleProps = {
  sparql: string;
  onSparqlChange: (query: string) => void;
  onRunSparql: (event: Event) => void;
  sparqlResult: unknown;
  busy: string;
};

const SAMPLE_QUERIES = [
  {
    label: "기본 트리플 조회",
    desc: "주어, 술어, 목적어를 최대 100건 조회합니다.",
    query: `SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object
}
LIMIT 100`
  },
  {
    label: "모든 클래스 타입",
    desc: "인스턴스에 지정된 RDF 타입별 개수를 조회합니다.",
    query: `SELECT DISTINCT ?type (COUNT(?subject) AS ?count)
WHERE {
  ?subject a ?type .
}
GROUP BY ?type
ORDER BY DESC(?count)`
  },
  {
    label: "연결된 관계 탐색",
    desc: "IRI로 연결된 직접 관계를 조회합니다.",
    query: `SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object .
  FILTER(isIRI(?object))
}
LIMIT 50`
  }
];

function pretty(value: unknown): string {
  if (value === undefined) return "정보 없음";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonBlock({ value, empty }: { value: unknown; empty: string }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return <p class="knowledge-muted">{empty}</p>;
  }
  return <pre class="knowledge-json">{pretty(value)}</pre>;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function KnowledgeSparqlConsole({
  sparql,
  onSparqlChange,
  onRunSparql,
  sparqlResult,
  busy
}: KnowledgeSparqlConsoleProps) {
  const isRunning = busy === "sparql";
  const [viewMode, setViewMode] = useState<"json" | "table">("table");
  const [copied, setCopied] = useState(false);
  const table = normalizeSparqlTableResult(sparqlResult);

  async function handleCopyTableTSV() {
    if (!table) return;
    const header = table.variables.join("\t");
    const rows = table.rows.map((row) =>
      table.variables.map((variable) => row[variable]?.value ?? "").join("\t")
    );
    try {
      await navigator.clipboard.writeText([header, ...rows].join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  function handleDownloadCSV() {
    if (!table) return;
    const header = table.variables.map(csvCell).join(",");
    const rows = table.rows.map((row) =>
      table.variables.map((variable) => csvCell(row[variable]?.value ?? "")).join(",")
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sparql-query-${Date.now()}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  return (
    <section class="panel knowledge-tool-card sparql-console-card" aria-label="SPARQL 질의 콘솔">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Read-only Knowledge Query Console</p>
          <h2>SPARQL 질의 콘솔</h2>
        </div>
        <div class="sparql-head-stats">
          <span class="version-stat-badge">읽기 전용 · 최대 {KNOWLEDGE_MAX_SPARQL_ROWS}행</span>
        </div>
      </div>

      <div class="sparql-layout">
        <div class="sparql-editor-section">
          <div class="card-section-head">
            <h3>SPARQL 질의문 작성</h3>
            <small>SELECT / ASK / CONSTRUCT / DESCRIBE</small>
          </div>
          <div class="sample-queries-row">
            <span>샘플 질의:</span>
            {SAMPLE_QUERIES.map((sample) => (
              <button
                type="button"
                key={sample.label}
                class="sample-query-btn"
                title={sample.desc}
                onClick={() => onSparqlChange(sample.query)}
              >
                {sample.label}
              </button>
            ))}
          </div>
          <form onSubmit={onRunSparql} class="sparql-form">
            <label for="knowledge-sparql-input" class="sr-only">SPARQL 질의문</label>
            <textarea
              id="knowledge-sparql-input"
              class="knowledge-code-input sparql-code-area"
              value={sparql}
              onInput={(event) => onSparqlChange(event.currentTarget.value)}
              spellcheck={false}
              rows={11}
            />
            <div class="knowledge-form-footer">
              <span class="sparql-limit-hint">UPDATE와 외부 SERVICE 질의는 보안상 차단됩니다.</span>
              <button class="button small" type="submit" disabled={!sparql.trim() || isRunning}>
                {isRunning ? "질의 실행 중…" : "SPARQL 실행"}
              </button>
            </div>
          </form>
        </div>

        <div class="sparql-results-section">
          <div class="results-header">
            <div class="results-title-row">
              <h3>질의 결과</h3>
              {table && (
                <span class="count-badge">
                  {table.queryForm} · {table.rows.length}행 · {table.complete ? "완료" : "불완전"}
                </span>
              )}
            </div>
            {table && (
              <div class="results-mode-toggle">
                <button
                  type="button"
                  class={`button secondary small ${viewMode === "table" ? "active" : ""}`}
                  onClick={() => setViewMode("table")}
                >
                  표 보기
                </button>
                <button
                  type="button"
                  class={`button secondary small ${viewMode === "json" ? "active" : ""}`}
                  onClick={() => setViewMode("json")}
                >
                  JSON
                </button>
                <button type="button" class="button secondary small" onClick={handleCopyTableTSV}>
                  {copied ? "복사됨" : "TSV 복사"}
                </button>
                <button type="button" class="button secondary small" onClick={handleDownloadCSV}>
                  CSV 다운로드
                </button>
              </div>
            )}
          </div>

          <div class="sparql-results-body">
            {viewMode === "table" && table ? (
              <div class="sparql-table-wrapper">
                <table class="sparql-table">
                  <thead>
                    <tr>{table.variables.map((variable) => <th key={variable}>?{variable}</th>)}</tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {table.variables.map((variable) => {
                          const item = row[variable];
                          return (
                            <td key={variable}>
                              {item ? (
                                <code title={describeSparqlTerm(item)}>{compactSparqlTerm(item)}</code>
                              ) : (
                                <span class="knowledge-muted">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <JsonBlock value={sparqlResult} empty="SPARQL 질의를 실행하면 결과가 여기에 표시됩니다." />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
