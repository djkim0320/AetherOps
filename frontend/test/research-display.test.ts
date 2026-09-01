import assert from "node:assert/strict";
import test from "node:test";

import { researchQuestionDisplay } from "../src/research-display.ts";

test("plain research questions are displayed unchanged", () => {
	assert.deepEqual(researchQuestionDisplay("  일반 연구 질문  "), {
		planned: false,
		text: "일반 연구 질문"
	});
});

test("planned research hides the internal execution contract and shows its goal", () => {
	const question = [
		"연구 목표:",
		"선택지 응답 전문",
		"",
		"계획 모드에서 합의된 실행 계획:",
		"# 목표",
		"소형 UAV용 에어포일의 XFOIL 결과와 풍동자료를 비교한다.",
		"",
		"# 실행 단계",
		"- 수집",
		"- 분석"
	].join("\n");

	assert.deepEqual(researchQuestionDisplay(question), {
		planned: true,
		title: "합의된 계획으로 연구를 시작했습니다.",
		text: "소형 UAV용 에어포일의 XFOIL 결과와 풍동자료를 비교한다."
	});
});

test("new planned runs use the final plan as their only executable question", () => {
	const question = [
		"계획 모드에서 합의된 실행 계획:",
		"# 목표",
		"NACA 0012 격자 수렴성을 검증한다.",
		"",
		"# 완료 기준",
		"- GCI를 계산한다."
	].join("\n");

	assert.deepEqual(researchQuestionDisplay(question), {
		planned: true,
		title: "합의된 계획으로 연구를 시작했습니다.",
		text: "NACA 0012 격자 수렴성을 검증한다."
	});
});

test("planned research without a goal section uses a compact pointer", () => {
	const display = researchQuestionDisplay("연구 목표:\n응답\n\n계획 모드에서 합의된 실행 계획:\n# 범위\n상세 계약");
	assert.equal(display.planned, true);
	assert.equal(display.text, "최종 계획은 바로 위 계획 카드에서 확인할 수 있습니다.");
	assert.equal(display.text.includes("상세 계약"), false);
});
