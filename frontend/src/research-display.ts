export type ResearchQuestionDisplay = {
	planned: boolean;
	title?: string;
	text: string;
};

const plannedResearchMarker = "\n\n계획 모드에서 합의된 실행 계획:\n";
const maxGoalLength = 240;

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateAtSentence(value: string): string {
	if (value.length <= maxGoalLength) return value;
	const candidate = value.slice(0, maxGoalLength + 1);
	const sentenceEnd = Math.max(candidate.lastIndexOf("."), candidate.lastIndexOf("다."));
	if (sentenceEnd >= Math.floor(maxGoalLength * 0.55)) return candidate.slice(0, sentenceEnd + 1).trim();
	return `${candidate.slice(0, maxGoalLength).trimEnd()}…`;
}

function extractGoal(plan: string): string {
	const match = plan.match(/^#{1,6}\s*목표\s*\r?\n([\s\S]*?)(?=\r?\n#{1,6}\s|$)/m);
	return match ? truncateAtSentence(compactText(match[1])) : "";
}

export function researchQuestionDisplay(question: string): ResearchQuestionDisplay {
	const normalized = question.trim();
	const markerIndex = normalized.indexOf(plannedResearchMarker);
	if (markerIndex < 0) {
		return { planned: false, text: normalized || "질문 없음" };
	}

	const plan = normalized.slice(markerIndex + plannedResearchMarker.length);
	return {
		planned: true,
		title: "합의된 계획으로 연구를 시작했습니다.",
		text: extractGoal(plan) || "최종 계획은 바로 위 계획 카드에서 확인할 수 있습니다."
	};
}
