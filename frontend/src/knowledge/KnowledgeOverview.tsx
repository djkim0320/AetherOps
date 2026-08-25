import type {
  KnowledgeGraph,
  KnowledgeMaterial,
  KnowledgeStatus
} from "../knowledge-types";
import type { KnowledgeTab } from "./KnowledgeToolbar";

export type KnowledgeOverviewProps = {
  status: KnowledgeStatus | null;
  graph: KnowledgeGraph;
  materials: KnowledgeMaterial[] | null;
  connected: boolean;
  busy: string;
  onNavigate: (tab: KnowledgeTab) => void;
  onRefresh: () => void;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function materialID(material: KnowledgeMaterial, index: number): string {
  return text(material.id) ?? text(material.material_id) ?? `material-${index + 1}`;
}

function materialDate(value: unknown): string {
  const source = text(value);
  if (!source) return "날짜 정보 없음";
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime())) return "날짜 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(parsed);
}

export function KnowledgeOverview({
  status,
  graph,
  materials,
  connected,
  busy,
  onNavigate,
  onRefresh
}: KnowledgeOverviewProps) {
  const state = text(status?.state) ?? (status?.ready ? "ready" : "unknown");
  const ready = status?.ready === true || state === "ready" || state === "active";
  const entityCount = number(status?.entity_count) ?? graph.totalNodes;
  const relationCount = number(status?.assertion_count) ?? graph.totalEdges;
  const evidenceCount = number(status?.evidence_count) ?? 0;
  const conflictCount = number(status?.conflict_count) ?? 0;
  const sourceCount = materials?.length ?? 0;
  const adoptedCount = materials?.filter((material) => material.graph_adopt === true).length ?? 0;
  const ontologyVersion =
    text(status?.active_ontology_version_id) ?? text(status?.activeOntologyVersionID) ?? "기본 스키마";
  const recentMaterials = [...(materials ?? [])]
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
    .slice(0, 4);

  return (
    <div class="knowledge-overview">
      <section class="panel knowledge-overview-hero">
        <div class="knowledge-overview-hero-copy">
          <p class="eyebrow">Project Understanding</p>
          <h2>AetherOps가 이 프로젝트에서 알고 있는 내용</h2>
          <p>
            채택된 자료에서 검증된 지식과 관계만 모아 보여줍니다. 근거가 부족하거나 서로 충돌하는
            내용은 자동으로 검토함에 분리됩니다.
          </p>
        </div>
        <div class="knowledge-overview-hero-actions">
          <button class="button" type="button" onClick={() => onNavigate("materials")}>
            자료 추가
          </button>
          <button
            class="button secondary"
            type="button"
            onClick={onRefresh}
            disabled={!connected || Boolean(busy)}
          >
            {busy === "refresh" ? "확인 중…" : "상태 확인"}
          </button>
        </div>
      </section>

      <section class="knowledge-overview-metrics" aria-label="프로젝트 지식 요약">
        <button type="button" class="knowledge-metric-card" onClick={() => onNavigate("materials")}>
          <span class="knowledge-metric-label">채택 자료</span>
          <strong>{sourceCount}</strong>
          <small>{adoptedCount}개가 지식 추출 대상입니다</small>
        </button>
        <button type="button" class="knowledge-metric-card" onClick={() => onNavigate("knowledge")}>
          <span class="knowledge-metric-label">확인된 지식</span>
          <strong>{entityCount}</strong>
          <small>개념, 대상, 분석 결과를 포함합니다</small>
        </button>
        <button type="button" class="knowledge-metric-card" onClick={() => onNavigate("graph")}>
          <span class="knowledge-metric-label">근거 있는 관계</span>
          <strong>{relationCount}</strong>
          <small>{evidenceCount}개의 근거가 연결돼 있습니다</small>
        </button>
        <button
          type="button"
          class={`knowledge-metric-card ${conflictCount > 0 ? "needs-review" : ""}`}
          onClick={() => onNavigate("review")}
        >
          <span class="knowledge-metric-label">검토 필요</span>
          <strong>{conflictCount}</strong>
          <small>{conflictCount > 0 ? "충돌하거나 확인이 필요한 항목입니다" : "현재 대기 중인 충돌이 없습니다"}</small>
        </button>
      </section>

      <div class="knowledge-overview-grid">
        <section class="panel knowledge-overview-section">
          <div class="knowledge-overview-section-head">
            <div>
              <p class="eyebrow">Knowledge Health</p>
              <h3>지식 상태</h3>
            </div>
            <span class={`knowledge-state ${state}`}>{ready ? "사용 가능" : state}</span>
          </div>

          <div class={`knowledge-health-message ${ready ? "ready" : "blocked"}`}>
            <strong>{ready ? "연구에 사용할 준비가 됐습니다" : "지식 상태를 확인해야 합니다"}</strong>
            <span>
              {ready
                ? "검색과 연구가 현재 활성 지식 세대에 연결됩니다."
                : "지식 세대가 준비되지 않으면 그래프 기반 연구가 시작되지 않습니다."}
            </span>
          </div>

          <dl class="knowledge-health-details">
            <div>
              <dt>활성 스키마</dt>
              <dd>{ontologyVersion}</dd>
            </div>
            <div>
              <dt>표시 범위</dt>
              <dd>
                {graph.totalNodes}개 지식 · {graph.totalEdges}개 관계
                {graph.truncated ? " (일부 표시)" : ""}
              </dd>
            </div>
            <div>
              <dt>연결 상태</dt>
              <dd>{connected ? "코어 연결됨" : "코어 연결 끊김"}</dd>
            </div>
          </dl>

          <div class="knowledge-overview-inline-actions">
            <button class="button secondary small" type="button" onClick={() => onNavigate("knowledge")}>
              지식 둘러보기
            </button>
            <button class="button secondary small" type="button" onClick={() => onNavigate("graph")}>
              관계도 열기
            </button>
          </div>
        </section>

        <section class="panel knowledge-overview-section">
          <div class="knowledge-overview-section-head">
            <div>
              <p class="eyebrow">Recent Sources</p>
              <h3>최근 자료</h3>
            </div>
            <button class="button ghost small" type="button" onClick={() => onNavigate("materials")}>
              모두 보기
            </button>
          </div>

          <div class="knowledge-recent-materials">
            {materials === null ? (
              <p class="knowledge-muted">자료 목록을 불러오는 중입니다…</p>
            ) : recentMaterials.length === 0 ? (
              <div class="knowledge-overview-empty">
                <strong>아직 채택된 자료가 없습니다</strong>
                <span>보고서나 데이터 파일을 추가하면 프로젝트 지식이 여기에 쌓입니다.</span>
                <button class="button small" type="button" onClick={() => onNavigate("materials")}>
                  첫 자료 추가
                </button>
              </div>
            ) : (
              recentMaterials.map((material, index) => (
                <article class="knowledge-recent-material" key={materialID(material, index)}>
                  <div>
                    <strong>{text(material.title) ?? materialID(material, index)}</strong>
                    <small>
                      {text(material.media_type) ?? "파일"} · {materialDate(material.created_at)}
                    </small>
                  </div>
                  <span class={material.graph_adopt ? "adopted" : "pinned"}>
                    {material.graph_adopt ? "지식 채택" : "자료 고정"}
                  </span>
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      <section class="knowledge-overview-footer" aria-label="고급 지식 도구">
        <span>온톨로지 스키마, SPARQL, JSON-LD 내보내기는 고급 도구에서 관리합니다.</span>
        <button class="button ghost small" type="button" onClick={() => onNavigate("advanced")}>
          고급 도구 열기
        </button>
      </section>
    </div>
  );
}
