import assert from "node:assert/strict";
import test from "node:test";

import { artifactContentPath } from "../src/artifact-path.ts";

test("artifact content uses the authenticated API route", () => {
	assert.equal(
		artifactContentPath("art_0123456789abcdef0123456789abcdef"),
		"/api/v1/artifacts/art_0123456789abcdef0123456789abcdef"
	);
});

test("artifact content rejects paths and malformed identifiers", () => {
	for (const value of ["", "art_bad", "../api/v1/artifacts/x", "ART_0123456789abcdef0123456789abcdef"]) {
		assert.throws(() => artifactContentPath(value), /Invalid AetherOps artifact identifier/);
	}
});
