import assert from "node:assert/strict";
import test from "node:test";

import { parseSlashCommand, planningObjective } from "../src/plan-cycle.ts";

test("planning objective snapshots multiple ordinary user requirements", () => {
	assert.equal(planningObjective([
		{ role: "user", mode: "chat", text: "NACA 0015를 연구하고 싶어." },
		{ role: "assistant", mode: "chat", text: "범위를 정해보죠." },
		{ role: "user", mode: "chat", text: "Re는 백만으로 하자." }
	]), "NACA 0015를 연구하고 싶어.\n\nRe는 백만으로 하자.");
});

test("an older plan and its choice answers never become a new objective", () => {
	assert.equal(planningObjective([
		{ role: "user", mode: "chat", text: "과거 목표" },
		{ role: "user", mode: "plan", text: "범위: 국내" },
		{ role: "assistant", mode: "plan", text: "과거 최종 계획" },
		{ role: "user", mode: "chat", text: "새 목표" }
	]), "새 목표");
});

test("explicit slash-command objective wins", () => {
	assert.equal(planningObjective([{ role: "user", mode: "chat", text: "이전" }], " 새 연구 "), "새 연구");
});

test("empty kickoff persists an explicit absence instead of an empty objective", () => {
	const objective = planningObjective([]);
	assert.match(objective, /아직 구체적인 연구 목표가 제시되지 않았습니다/);
	assert.notEqual(objective, "");
});

test("slash plan accepts a natural-language objective on the same input", () => {
	assert.deepEqual(parseSlashCommand(" /PLAN  NACA 0012를 실제 SU2로 검증해 줘\n조건표도 포함해 "), {
		command: "/plan",
		argument: "NACA 0012를 실제 SU2로 검증해 줘\n조건표도 포함해"
	});
	assert.deepEqual(parseSlashCommand("/research"), { command: "/research", argument: "" });
	assert.equal(parseSlashCommand("ordinary chat"), null);
});
