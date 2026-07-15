export const TOOL_SIDE_EFFECT_TABLE = "tool_side_effect_reservations";

export const TOOL_SIDE_EFFECT_COLUMNS = [
  "project_id",
  "side_effect_key",
  "attempt_id",
  "job_id",
  "idempotency_key",
  "input_hash",
  "descriptor_version",
  "status",
  "generation",
  "reserved_at",
  "resolved_at"
];

export const TOOL_SIDE_EFFECT_INDEXES = ["idx_tool_side_effect_reservations_job", "idx_tool_side_effect_reservations_status"];

export const TOOL_SIDE_EFFECT_TRIGGERS = ["trg_tool_side_effect_reservations_owner_insert", "trg_tool_side_effect_reservations_owner_update"];

export const TOOL_SIDE_EFFECT_FOREIGN_KEYS = ["jobs", "tool_attempts"];
