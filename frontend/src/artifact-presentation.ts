export type ArtifactPresentation = {
	label: string;
	title: string;
	description: string;
	tone: "plan" | "evidence" | "report" | "review" | "analysis" | "model" | "data" | "verification" | "artifact";
};

const exactPresentations: Record<string, ArtifactPresentation> = {
	"research.plan": { label: "계획", title: "연구 계획", description: "연구 범위와 조사·분석 방법", tone: "plan" },
	"research.evidence": { label: "근거", title: "수집된 근거", description: "출처와 핵심 증거를 정리한 자료", tone: "evidence" },
	"research.evidence.verification": { label: "검증", title: "근거 검증 결과", description: "출처와 인용 무결성을 확인한 기록", tone: "verification" },
	"research.report": { label: "보고서", title: "연구 결과 보고서", description: "수집된 근거와 분석 결론을 정리한 검토 대상 보고서", tone: "report" },
	"research.report.revision": { label: "보고서", title: "수정된 연구 보고서", description: "품질 검토 의견을 반영한 연구 결과", tone: "report" },
	"research.report.document": { label: "Word", title: "최종 연구 보고서 문서", description: "AetherOps 보고서 템플릿으로 발행한 검증 완료 Word 문서", tone: "report" },
	"research.review": { label: "리뷰", title: "품질 검토 결과", description: "근거·완전성·재현성에 대한 평가", tone: "review" },
	"engineering.xfoil_polar.input": { label: "해석", title: "XFOIL 해석 조건", description: "레이놀즈수와 받음각 등 계산 입력값", tone: "analysis" },
	"engineering.xfoil_polar.geometry": { label: "형상", title: "익형 형상", description: "해석에 사용된 익형 좌표와 플랩 형상", tone: "model" },
	"engineering.xfoil_polar.polar": { label: "성능", title: "공력 성능 데이터", description: "받음각별 양력·항력·모멘트 결과", tone: "data" },
	"engineering.xfoil_polar.receipt": { label: "검증", title: "XFOIL 실행 기록", description: "솔버 설정과 산출물 무결성 기록", tone: "verification" },
	"engineering.xfoil_polar.result": { label: "결과", title: "XFOIL 해석 결과", description: "구조화된 공력 계산 결과", tone: "analysis" },
	"engineering.mesh.su2": { label: "격자", title: "SU2 해석 격자", description: "CFD 계산에 사용된 격자 데이터", tone: "model" },
	"engineering.su2_cfd.receipt": { label: "검증", title: "SU2 실행 기록", description: "CFD 입력·물리 설정과 산출물 무결성 기록", tone: "verification" },
	"engineering.openvsp_wing_aero.model": { label: "모델", title: "OpenVSP 항공기 모델", description: "공력 해석에 사용된 3차원 형상", tone: "model" }
};

const rolePresentations: Record<string, ArtifactPresentation> = {
	input: { label: "입력", title: "해석 입력 조건", description: "계산에 사용된 조건과 설정", tone: "analysis" },
	config: { label: "설정", title: "솔버 설정", description: "해석 실행에 사용된 구성", tone: "analysis" },
	geometry: { label: "형상", title: "해석 형상", description: "계산에 사용된 형상 데이터", tone: "model" },
	mesh: { label: "격자", title: "해석 격자", description: "수치 해석에 사용된 계산 격자", tone: "model" },
	model: { label: "모델", title: "공학 모델", description: "해석에 사용된 모델 데이터", tone: "model" },
	polar: { label: "성능", title: "공력 성능 데이터", description: "양력·항력·모멘트 계산 결과", tone: "data" },
	result: { label: "결과", title: "공학 해석 결과", description: "구조화된 계산 결과", tone: "analysis" },
	results: { label: "결과", title: "공학 해석 결과", description: "구조화된 계산 결과", tone: "analysis" },
	receipt: { label: "검증", title: "해석 실행 기록", description: "솔버 설정과 산출물 무결성 기록", tone: "verification" },
	graph: { label: "그래프", title: "결과 그래프", description: "해석 결과를 시각화한 자료", tone: "data" },
	data: { label: "데이터", title: "해석 데이터", description: "분석에 사용하거나 생성된 수치 자료", tone: "data" }
};

function inferredRole(normalized: string): string | undefined {
	const parts = normalized.split(/[._/-]+/).filter(Boolean);
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		if (rolePresentations[parts[index]]) return parts[index];
	}
	return undefined;
}

export function artifactPresentation(kind: string | undefined): ArtifactPresentation {
	const normalized = kind?.trim().toLowerCase() ?? "";
	if (exactPresentations[normalized]) return exactPresentations[normalized];
	const role = inferredRole(normalized);
	if (normalized.startsWith("engineering.") && role) return rolePresentations[role];
	if (normalized.startsWith("engineering.")) return { label: "공학", title: "공학 해석 자료", description: "해석 과정에서 생성된 기술 자료", tone: "analysis" };
	if (normalized.startsWith("research.") && role) return rolePresentations[role];
	if (normalized.startsWith("research.")) return { label: "연구", title: "연구 산출물", description: "연구 과정에서 채택된 자료", tone: "artifact" };
	return { label: "자료", title: "연구 산출물", description: "연구 과정에서 생성된 자료", tone: "artifact" };
}
