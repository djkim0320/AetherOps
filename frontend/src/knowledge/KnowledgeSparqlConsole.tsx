import { useState } from "preact/hooks";
import { KNOWLEDGE_MAX_SPARQL_ROWS } from "../knowledge-types";

export type KnowledgeSparqlConsoleProps = {
  sparql: string;
  onSparqlChange: (query: string) => void;
  onRunSparql: (e: Event) => void;
  sparqlResult: unknown;
  busy: string;
};

const SAMPLE_QUERIES = [
  {
    label: "기본 트리플 조회",
    query: `SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object
}
LIMIT 100`
  },
  {
    label: "모든 클래스 타입",
    query: `SELECT DISTINCT ?type (COUNT(?s) AS ?count)
WHERE {
  ?s a ?type .
}
GROUP BY ?type
ORDER BY DESC(?count)`
  },
  {
    label: "연결된 관계 탐색",
    query: `SELECT ?subject ?p ?object
WHERE {
  ?subject ?p ?object .
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

function JsonBlock({ value, empty = "정보가 없습니다." }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    return <p class="knowledge-muted">{empty}</p>;
  }
  return <pre class="knowledge-json">{pretty(value)}</pre>;
}

export function KnowledgeSparqlConsole({
  sparql,
  onSparqlChange,
  onRunSparql,
  sparqlResult,
  busy
}: KnowledgeSparqlConsoleProps) {
  const isRunning = busy === "sparql";
  const [viewMode, setViewMode] = useState<"json" | "table">("json");

  // Attempt to parse tabular results if W3C SPARQL JSON format
  const sparqlBindings =
    sparqlResult &&
    typeof sparqlResult === "object" &&
    "results" in (sparqlResult as Record<string, unknown>) &&
    Array.isArray(
      ((sparqlResult as Record<string, unknown>).results as Record<string, unknown>)?.bindings
    )
      ? (((sparqlResult as Record<string, unknown>).results as Record<string, unknown>)
          .bindings as Array<Record<string, { value?: string }>>)
      : null;

  const sparqlVars =
    sparqlResult &&
    typeof sparqlResult === "object" &&
    "head" in (sparqlResult as Record<string, unknown>) &&
    Array.isArray(((sparqlResult as Record<string, unknown>).head as Record<string, unknown>)?.vars)
      ? (((sparqlResult as Record<string, unknown>).head as Record<string, unknown>).vars as string[])
      : null;

  return (
    <section class="panel knowledge-tool-card sparql-console-card" aria-label="SPARQL 질의 콘솔">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Read-only Query</p>
          <h2>SPARQL 질의 콘솔</h2>
        </div>
      </div>

      <div class="sparql-layout">
        {/* Editor Area */}
        <div class="sparql-editor-section">
          <div class="sample-queries-row">
            <span>샘플 질의:</span>
            {SAMPLE_QUERIES.map((sample) => (
              <button
                type="button"
                key={sample.label}
                class="sample-query-btn"
                onClick={() => onSparqlChange(sample.query)}
              >
                {sample.label}
              </button>
            ))}
          </div>

          <form onSubmit={onRunSparql} class="sparql-form">
            <label for="knowledge-sparql-input" class="sr-only">
              SPARQL 질의문
            </label>
            <textarea
              id="knowledge-sparql-input"
              class="knowledge-code-input sparql-code-area"
              value={sparql}
              onInput={(e) => onSparqlChange(e.currentTarget.value)}
              spellcheck={false}
              rows={8}
            />

            <div class="knowledge-form-footer">
              <span class="sparql-limit-hint">
                최대 {KNOWLEDGE_MAX_SPARQL_ROWS}행 반환 · 읽기 전용 (UPDATE/SERVICE 차단)
              </span>
              <button
                class="button small"
                type="submit"
                disabled={!sparql.trim() || isRunning}
              >
                {isRunning ? "질의 실행 중…" : "SPARQL 실행"}
              </button>
            </div>
          </form>
        </div>

        {/* Results Area */}
        <div class="sparql-results-section">
          <div class="results-header">
            <h3>질의 결과</h3>
            {sparqlBindings && sparqlVars && (
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
                  JSON 원문
                </button>
              </div>
            )}
          </div>

          <div class="sparql-results-body">
            {viewMode === "table" && sparqlBindings && sparqlVars ? (
              <div class="sparql-table-wrapper">
                <table class="sparql-table">
                  <thead>
                    <tr>
                      {sparqlVars.map((v) => (
                        <th key={v}>?{v}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sparqlBindings.map((row, idx) => (
                      <tr key={idx}>
                        {sparqlVars.map((v) => (
                          <td key={v}>{row[v]?.value ?? "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <JsonBlock value={sparqlResult} empty="질의 결과가 여기에 표시됩니다." />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
