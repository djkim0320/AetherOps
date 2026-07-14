import { stableStringify } from "./hash.mjs";

const MAX_POLICY_NODES = 20_000;
const MAX_POLICY_DEPTH = 32;
const SECRET_KEY = /^(?:api_?key|authorization|cookie|credential|password|secret|token|access_?token|refresh_?token)$/i;

export function sanitizeMigratedJobPolicy(toolPolicyText, payloadText) {
  const toolPolicy = sanitizePolicyJson(toolPolicyText, "jobs.tool_policy");
  const payload = sanitizePayloadPolicyPaths(payloadText);
  return {
    unsafe: toolPolicy.changed || payload.changed,
    toolPolicyText: toolPolicy.changed ? null : toolPolicy.text,
    payloadText: payload.text
  };
}

export function migratedJobPolicyDisposition(row, options = {}) {
  const policy = sanitizeMigratedJobPolicy(row.tool_policy, row.payload);
  const wasActive = ["running", "pause_requested", "cancel_requested"].includes(row.status);
  const requiresReplan = policy.unsafe && !["completed", "failed", "aborted"].includes(row.status);
  const next = { ...row, payload: policy.payloadText };
  if (Object.prototype.hasOwnProperty.call(row, "tool_policy")) next.tool_policy = policy.toolPolicyText;
  if (requiresReplan) {
    next.status = "blocked";
    if (Object.prototype.hasOwnProperty.call(row, "blocked_reason")) next.blocked_reason = "replan_required_unsafe_source_policy_removed";
    next.error = "replan_required_unsafe_source_policy_removed";
  } else if (wasActive && options.interruptActive) {
    next.status = "interrupted";
    next.error ??= "migration_active_job_interrupted";
  }
  if (requiresReplan || (wasActive && options.interruptActive)) {
    next.lease_owner = null;
    next.lease_expires_at = null;
    next.completed_at ??= row.updated_at ?? row.created_at;
  }
  return { row: next, unsafe: policy.unsafe, requiresReplan };
}

export function sanitizeLegacyJobPolicies(db, interruptActive) {
  const rows = db.prepare("select * from jobs order by id").all();
  const update = db.prepare(
    `update jobs set status=?,tool_policy=?,blocked_reason=?,lease_owner=?,lease_expires_at=?,completed_at=?,payload=?,error=? where id=?`
  );
  for (const source of rows) {
    const row = migratedJobPolicyDisposition(source, { interruptActive }).row;
    update.run(
      row.status,
      row.tool_policy ?? null,
      row.blocked_reason ?? null,
      row.lease_owner ?? null,
      row.lease_expires_at ?? null,
      row.completed_at ?? null,
      row.payload,
      row.error ?? null,
      row.id
    );
  }
}

function sanitizePolicyJson(value, label) {
  const parsed = parseJson(value, label);
  if (!parsed.present) return { text: null, changed: false };
  const state = { nodes: 0, changed: false };
  const sanitized = scrub(parsed.value, undefined, 0, state);
  return { text: state.changed ? stableStringify(sanitized) : parsed.text, changed: state.changed };
}

function sanitizePayloadPolicyPaths(value) {
  const parsed = parseJson(value, "jobs.payload");
  if (!parsed.present) return { text: null, changed: false };
  const request = objectValue(parsed.value)?.request;
  const requestObject = objectValue(request);
  if (!requestObject) return { text: parsed.text, changed: false };
  let changed = sanitizeObjectPolicy(requestObject, "toolPolicy");
  const anchor = objectValue(requestObject.canonicalInitializationAnchor);
  const immutablePolicy = objectValue(anchor?.immutablePolicy);
  if (immutablePolicy) changed = sanitizeObjectPolicy(immutablePolicy, "toolPolicy") || changed;
  return { text: changed ? stableStringify(parsed.value) : parsed.text, changed };
}

function sanitizeObjectPolicy(owner, key) {
  if (!Object.prototype.hasOwnProperty.call(owner, key)) return false;
  const state = { nodes: 0, changed: false };
  const sanitized = scrub(owner[key], undefined, 0, state);
  if (state.changed) owner[key] = sanitized;
  return state.changed;
}

function parseJson(value, label) {
  if (value === null || value === undefined) return { present: false, text: null, value: undefined };
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    throw new Error(`Migration rejected malformed ${label} JSON.`, { cause: error });
  }
  return { present: true, text: typeof value === "string" ? value : stableStringify(value), value: parsed };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function scrub(value, key, depth, state) {
  state.nodes += 1;
  if (state.nodes > MAX_POLICY_NODES || depth > MAX_POLICY_DEPTH) throw new Error("Migration rejected an unbounded legacy job policy payload.");
  if (key && SECRET_KEY.test(key)) {
    if (value === "[removed-secret]") return value;
    state.changed = true;
    return "[removed-secret]";
  }
  if (typeof value === "string") {
    if (unsafeHttpUrl(value)) {
      state.changed = true;
      return "[removed-unsafe-source-url]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, key, depth + 1, state));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => [childKey, scrub(entry, childKey, depth + 1, state)]));
}

function unsafeHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return ["http:", "https:"].includes(url.protocol) && Boolean(url.username || url.password || url.search || url.hash);
}
