import assert from "node:assert/strict";
import test from "node:test";

import { artifactPresentation } from "../src/artifact-presentation.ts";

test("research artifacts use reader-facing titles", () => {
	assert.equal(artifactPresentation("research.report").title, "최종 연구 보고서");
	assert.equal(artifactPresentation("research.report.document").title, "최종 연구 보고서 문서");
	assert.equal(artifactPresentation("research.evidence.verification").title, "근거 검증 결과");
});

test("known engineering artifacts explain their meaning", () => {
	const polar = artifactPresentation("engineering.xfoil_polar.polar");
	assert.equal(polar.title, "공력 성능 데이터");
	assert.match(polar.description, /양력·항력·모멘트/);
	assert.equal(artifactPresentation("engineering.xfoil_polar.geometry").title, "익형 형상");
});

test("new engineering roles remain readable without exposing the raw kind", () => {
	const knownRole = artifactPresentation("engineering.future_solver.result");
	assert.equal(knownRole.title, "공학 해석 결과");
	assert.equal(knownRole.title.includes("engineering."), false);
	const unknownRole = artifactPresentation("engineering.future_solver.telemetry_bundle");
	assert.equal(unknownRole.title, "공학 해석 자료");
	assert.equal(unknownRole.description.includes("telemetry_bundle"), false);
});

test("missing kinds receive a neutral presentation", () => {
	assert.equal(artifactPresentation(undefined).title, "연구 산출물");
});
