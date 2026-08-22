import assert from "node:assert/strict";
import test from "node:test";

import { shouldRefreshApprovals } from "../src/approval-events.ts";

test("approval lifecycle events refresh the pending approval list", () => {
	assert.equal(shouldRefreshApprovals("approval.requested"), true);
	assert.equal(shouldRefreshApprovals("approval.decided"), true);
	assert.equal(shouldRefreshApprovals("approval.expired"), true);
});

test("unrelated or malformed run events do not refresh approvals", () => {
	assert.equal(shouldRefreshApprovals("run.transitioned"), false);
	assert.equal(shouldRefreshApprovals("approval"), false);
	assert.equal(shouldRefreshApprovals(undefined), false);
});
