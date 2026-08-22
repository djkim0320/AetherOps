import assert from "node:assert/strict";
import test from "node:test";

import { blockingRunFrom, canDiscardRun } from "../src/run-controls.ts";

test("uncertain and interrupted runs are discardable only while controls are idle", () => {
	assert.equal(canDiscardRun("uncertain", null), true);
	assert.equal(canDiscardRun("interrupted", null), true);
	assert.equal(canDiscardRun("queued", null), false);
	assert.equal(canDiscardRun("uncertain", "run-discard"), false);
});

test("a cross-session FIFO blocker is parsed only from a complete API reference", () => {
	assert.deepEqual(blockingRunFrom({ blocking_run: {
		id: "run_old", conversation_session_id: "session_old", status: "uncertain", error: "receipt mismatch"
	} }), {
		id: "run_old", conversation_session_id: "session_old", status: "uncertain", error: "receipt mismatch"
	});
	assert.equal(blockingRunFrom({ blocking_run: null }), null);
	assert.equal(blockingRunFrom({ blocking_run: { id: "run_old", status: "uncertain" } }), null);
});
