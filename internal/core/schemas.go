package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func PlanSchema() json.RawMessage {
	return json.RawMessage(`{
  "type":"object",
  "properties":{
    "question":{"type":"string","minLength":1},
    "mode":{"type":"string","enum":["general","engineering"]},
    "workstreams":{"type":"array","minItems":1,"maxItems":3,"items":{
      "type":"object",
      "properties":{
        "id":{"type":"string","minLength":1},
        "question":{"type":"string","minLength":1},
        "preferred_source_kinds":{"type":"array","items":{"type":"string"}},
        "required_evidence":{"type":"array","items":{"type":"string"}}
      },
      "required":["id","question","preferred_source_kinds","required_evidence"],
      "additionalProperties":false
    }},
    "source_requirements":{"type":"array","items":{"type":"string"}},
    "acceptance_criteria":{"type":"array","items":{"type":"string"}},
    "xfoil_screening":{"description":"Exact immutable candidate sweep when the question requires XFOIL flap optimization; otherwise null.","anyOf":[
      {"type":"null"},
      {"type":"object","properties":{
        "naca":{"type":"string","pattern":"^[0-9]{4}$"},
        "reynolds":{"type":"number"},"mach":{"type":"number"},
        "alpha_start_deg":{"type":"number"},"alpha_end_deg":{"type":"number"},"alpha_step_deg":{"type":"number"},
        "flap_chord_ratio":{"type":"number"},"flap_hinge_x_over_c":{"type":"number"},"flap_hinge_y_over_c":{"type":"number"},
        "candidate_flap_deflections_deg":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"number"}},
        "ncrit":{"type":"number"},"iterations":{"type":"integer"},"panel_count":{"type":"integer"},
        "optimization_objective":{"type":"string","const":"minimize_cd_at_target_cl"},
        "target_cl":{"type":"number"},"minimum_cm":{"type":"number"},
        "operating_points":{"description":"Optional bounded declarative matrix. When present, execute every operating point with every flap candidate through the existing typed XFOIL tool; the scalar condition fields remain the primary/default point for backward compatibility.","type":"array","maxItems":16,"items":{"type":"object","properties":{
          "id":{"type":"string","pattern":"^[a-z][a-z0-9_-]{0,31}$"},
          "reynolds":{"type":"number"},"mach":{"type":"number"},"ncrit":{"type":"number"},
          "target_cl":{"type":"number"},"minimum_cm":{"type":"number"}
        },"required":["id","reynolds","mach","ncrit","target_cl","minimum_cm"],"additionalProperties":false}}
      },"required":["naca","reynolds","mach","alpha_start_deg","alpha_end_deg","alpha_step_deg","flap_chord_ratio","flap_hinge_x_over_c","flap_hinge_y_over_c","candidate_flap_deflections_deg","ncrit","iterations","panel_count","optimization_objective","target_cl","minimum_cm","operating_points"],"additionalProperties":false}
    ]},
    "su2_mesh_study":{"description":"Exact immutable contract for the bundled fixed-domain NACA0012 SU2 grid-sensitivity workflow; otherwise null.","anyOf":[
      {"type":"null"},
      {"type":"object","properties":{
		"execution_mode":{"type":"string","enum":["execute","readback_existing"]},
        "profile":{"type":"string","const":"su2_naca0012_grid_sensitivity/v1"},
        "naca":{"type":"string","const":"0012"},
        "mach":{"type":"number"},"alpha_deg":{"type":"number"},"iterations":{"type":"integer"},
        "mesh_sizes_m":{"type":"array","minItems":3,"maxItems":8,"items":{"type":"number"}},
        "domain_profile":{"type":"string","const":"rect_xm10_xp15_ym10_yp10/v1"},
        "objective":{"type":"string","const":"assess_grid_sensitivity"},
        "reference_comparison":{"type":"string","const":"qualitative_context"}
      },"required":["execution_mode","profile","naca","mach","alpha_deg","iterations","mesh_sizes_m","domain_profile","objective","reference_comparison"],"additionalProperties":false}
    ]}
  },
  "required":["question","mode","workstreams","source_requirements","acceptance_criteria","xfoil_screening","su2_mesh_study"],
  "additionalProperties":false
}`)
}

func EvidenceSchema() json.RawMessage {
	return json.RawMessage(`{
  "type":"object",
  "properties":{
    "workstream_id":{"type":"string"},
    "summary":{"type":"string"},
    "claims":{"type":"array","items":{"type":"object","properties":{
      "id":{"type":"string"},"statement":{"type":"string"},
      "source_ids":{"type":"array","minItems":1,"items":{"type":"string"}},
      "counterevidence":{"type":"string"}
    },"required":["id","statement","source_ids","counterevidence"],"additionalProperties":false}},
	"sources":{"type":"array","description":"Captured public HTTP(S) sources only. Call aetherops_internal.evidence_capture with URL metadata, then copy its returned fields exactly. Never put an engineering receipt in this array; reference its exact receipt_artifact_id through engineering_receipt_artifact_ids instead.","items":{"type":"object","properties":{
	      "id":{"type":"string"},"url":{"type":"string","pattern":"^https?://","description":"Canonical public HTTP(S) URL returned by evidence_capture."},"title":{"type":"string"},
	      "publisher":{"type":"string"},"captured_at":{"type":"string","format":"date-time","description":"Exact captured_at returned by a successful evidence_capture call. Never use year 1, Unix epoch, or another placeholder time."},
	      "blob_hash":{"type":"string","pattern":"^[a-f0-9]{64}$","description":"Exact blob_hash returned by evidence_capture; never empty or invented."}
	    },"required":["id","url","title","publisher","captured_at","blob_hash"],"additionalProperties":false}},
	"engineering_receipt_artifact_ids":{"type":"array","description":"Exact receipt_artifact_id values from successful typed AetherOps engineering calls. Each value is art_ followed by 32 lowercase hexadecimal characters. Never use a 64-character CAS blob hash, artifact hash, or value hash here. AetherOps verifies exact run and collector-attempt ownership and rehydrates immutable receipt metadata from SQLite/CAS.","items":{"type":"string","pattern":"^art_[a-f0-9]{32}$"}},
	    "limitations":{"type":"array","items":{"type":"string"}}
	  },
	  "required":["workstream_id","summary","claims","sources","engineering_receipt_artifact_ids","limitations"],
	  "additionalProperties":false
}`)
}

const knowledgeTypedLiteralSchema = `{
  "type":"object",
  "properties":{
    "lexical_form":{"type":"string"},
    "datatype":{"type":"string"},
    "language":{"type":"string"},
    "unit":{"type":"string"},
    "si_value":{"type":"string"},
    "si_unit":{"type":"string"}
  },
  "required":["lexical_form","datatype","language","unit","si_value","si_unit"],
  "additionalProperties":false
}`

// knowledgeEvidenceRefSchema is deliberately a union of mutually exclusive
// wire shapes. Requiring one superset object made models populate both text
// and engineering fields, even though the core correctly rejects mixed
// provenance. Every branch remains strict for structured-output compatibility.
const knowledgeEvidenceRefSchema = `{
  "description":"Choose exactly one evidence shape. Never combine text and engineering fields.",
  "anyOf":[
    {
      "type":"object",
      "description":"An exact UTF-8 byte span in a captured CAS text blob.",
      "properties":{
        "kind":{"type":"string","const":"text"},
        "source_id":{"type":"string","minLength":1},
        "claim_id":{"type":"string","minLength":1},
        "blob_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "byte_start":{"type":"integer","minimum":0},
        "byte_end":{"type":"integer","minimum":1},
        "span_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}
      },
      "required":["kind","source_id","claim_id","blob_hash","byte_start","byte_end","span_hash"],
      "additionalProperties":false
    },
    {
      "type":"object",
      "description":"An exact JSON value in a run-owned engineering CAS artifact. Copy a complete handle returned by engineering_get.",
      "properties":{
        "kind":{"type":"string","const":"engineering"},
        "artifact_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "json_pointer":{"type":"string","pattern":"^/"},
        "value_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}
      },
      "required":["kind","artifact_hash","json_pointer","value_hash"],
      "additionalProperties":false
    },
    {
      "type":"object",
      "description":"An exact one-based CSV record in a run-owned engineering CAS artifact. Use only a complete handle supplied by a tool.",
      "properties":{
        "kind":{"type":"string","const":"engineering"},
        "artifact_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"},
        "csv_row":{"type":"integer","minimum":1},
        "value_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}
      },
      "required":["kind","artifact_hash","csv_row","value_hash"],
      "additionalProperties":false
    }
  ]
}`

func KnowledgePatchSchema() json.RawMessage {
	nullableLiteral := `{"anyOf":[{"type":"null"},` + knowledgeTypedLiteralSchema + `]}`
	nullableTimeRange := `{"anyOf":[{"type":"null"},{
      "type":"object",
      "properties":{"start":{"type":"string"},"end":{"type":"string"}},
      "required":["start","end"],
      "additionalProperties":false
    }]}`
	qualifier := `{
    "type":"object",
    "properties":{
      "predicate":{"type":"string"},
      "entity_id":{"type":"string"},
      "literal":` + nullableLiteral + `
    },
    "required":["predicate","entity_id","literal"],
    "additionalProperties":false
  }`
	return json.RawMessage(`{
  "type":"object",
  "properties":{
    "schema_version":{"type":"string","const":"knowledge_patch_v1"},
	"unit_registry_version":{"type":"string","const":"unit_registry_v1"},
    "entities":{"type":"array","items":{
      "type":"object",
      "properties":{
        "id":{"type":"string"},
        "type":{"type":"string"},
        "canonical_name":{"type":"string"},
        "aliases":{"type":"array","items":{
          "type":"object",
          "properties":{"value":{"type":"string"},"language":{"type":"string"}},
          "required":["value","language"],
          "additionalProperties":false
        }}
      },
      "required":["id","type","canonical_name","aliases"],
      "additionalProperties":false
    }},
    "assertions":{"type":"array","items":{
      "type":"object",
      "properties":{
        "id":{"type":"string"},
        "subject_entity_id":{"type":"string"},
        "predicate":{"type":"string"},
        "object_entity_id":{"type":"string"},
        "object_literal":` + nullableLiteral + `,
        "qualifiers":{"type":"array","items":` + qualifier + `},
        "valid_time":` + nullableTimeRange + `,
        "evidence":{"type":"array","items":` + knowledgeEvidenceRefSchema + `}
      },
      "required":["id","subject_entity_id","predicate","object_entity_id","object_literal","qualifiers","valid_time","evidence"],
      "additionalProperties":false
    }}
  },
  "required":["schema_version","unit_registry_version","entities","assertions"],
  "additionalProperties":false
}`)
}

func ReportSchema() json.RawMessage {
	return json.RawMessage(`{
  "type":"object",
  "properties":{
    "title":{"type":"string"},"answer_markdown":{"type":"string"},
    "citations":{"type":"array","minItems":1,"items":{"type":"object","properties":{
      "marker":{"type":"string","minLength":1},"source_ids":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}},
      "claim_ids":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}
    },"required":["marker","source_ids","claim_ids"],"additionalProperties":false}},
    "evidence_ids":{"description":"Every EvidenceBundle.workstream_id from the synthesis input, exactly once. These are not source IDs or artifact IDs.","type":"array","items":{"type":"string"}},
    "artifact_hashes":{"type":"array","items":{"type":"string"}},
    "uncertainties":{"type":"array","items":{"type":"string"}},
    "knowledge_patch":` + string(KnowledgePatchSchema()) + `
  },
  "required":["title","answer_markdown","citations","evidence_ids","artifact_hashes","uncertainties","knowledge_patch"],
  "additionalProperties":false
}`)
}

// ReportSchemaForEvidenceIDs closes an ambiguity that static JSON Schema cannot:
// evidence_ids are EvidenceBundle workstream identities, not source or artifact
// identities. Constraining both the vocabulary and cardinality makes structured
// output include every collected bundle exactly once before semantic validation.
func ReportSchemaForEvidenceIDs(evidenceIDs []string) (json.RawMessage, error) {
	if len(evidenceIDs) == 0 {
		return nil, errors.New("report schema requires at least one evidence id")
	}
	seen := make(map[string]struct{}, len(evidenceIDs))
	allowed := make([]string, 0, len(evidenceIDs))
	for _, id := range evidenceIDs {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, errors.New("report schema has an empty evidence id")
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("report schema repeats evidence id %q", id)
		}
		seen[id] = struct{}{}
		allowed = append(allowed, id)
	}

	var schema map[string]any
	if err := json.Unmarshal(ReportSchema(), &schema); err != nil {
		return nil, fmt.Errorf("decode report schema: %w", err)
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return nil, errors.New("report schema properties are missing")
	}
	evidenceProperty, ok := properties["evidence_ids"].(map[string]any)
	if !ok {
		return nil, errors.New("report schema evidence_ids property is missing")
	}
	evidenceProperty["items"] = map[string]any{"type": "string", "enum": allowed}
	evidenceProperty["minItems"] = len(allowed)
	evidenceProperty["maxItems"] = len(allowed)

	encoded, err := json.Marshal(schema)
	if err != nil {
		return nil, fmt.Errorf("encode constrained report schema: %w", err)
	}
	return json.RawMessage(encoded), nil
}

func ReviewSchema() json.RawMessage {
	return json.RawMessage(`{
  "type":"object",
  "properties":{
    "citation_integrity_percent":{"type":"integer","minimum":0,"maximum":100},
    "knowledge_integrity":{"type":"object","properties":{
      "evidence_integrity_percent":{"type":"integer","minimum":0,"maximum":100},
      "unsupported_assertions":{"type":"integer","minimum":0}
    },"required":["evidence_integrity_percent","unsupported_assertions"],"additionalProperties":false},
    "critical_errors":{"type":"array","items":{"type":"string"}},
    "scores":{"type":"object","properties":{
      "task_fulfillment":{"description":"1 is worst and 5 is best.","type":"integer","minimum":1,"maximum":5},
      "claim_support":{"description":"1 is worst and 5 is best.","type":"integer","minimum":1,"maximum":5},
      "source_quality":{"description":"1 is worst and 5 is best.","type":"integer","minimum":1,"maximum":5},
      "completeness":{"description":"1 is worst and 5 is best.","type":"integer","minimum":1,"maximum":5},
      "reasoning_and_uncertainty":{"description":"1 is worst and 5 is best.","type":"integer","minimum":1,"maximum":5},
      "clarity_and_reproducibility":{"description":"1 is worst and 5 is best.","type":"integer","minimum":1,"maximum":5}
    },"required":["task_fulfillment","claim_support","source_quality","completeness","reasoning_and_uncertainty","clarity_and_reproducibility"],"additionalProperties":false},
    "revision_requests":{"type":"array","items":{"type":"string"}},
	"remediation_action":{"description":"Use none only for a passing report. Every failing review must use additional_research or replan so AetherOps creates a fresh plan and collection cycle. Use additional_research when the scope is sound but more evidence or computation is required. Use replan when the workstreams, scope, acceptance criteria, or executable analysis contract are wrong.","type":"string","enum":["none","additional_research","replan"]},
	"remediation_tasks":{"type":"array","items":{"type":"object","properties":{
	  "objective":{"type":"string","minLength":1},
	  "required_evidence":{"type":"array","items":{"type":"string"}},
	  "requires_engineering":{"description":"True when the task needs engineering receipts, deterministic post-processing, or engineering analysis, including readback of existing results.","type":"boolean"},
	  "requires_new_solver_execution":{"description":"True only when a genuinely missing solver run at a new or previously unexecuted contract is required. Keep false for receipt readback, plotting, audit tables, or reanalysis of existing solver artifacts.","type":"boolean"}
	},"required":["objective","required_evidence","requires_engineering","requires_new_solver_execution"],"additionalProperties":false}},
    "summary":{"type":"string"}
  },
  "required":["citation_integrity_percent","knowledge_integrity","critical_errors","scores","revision_requests","remediation_action","remediation_tasks","summary"],
  "additionalProperties":false
}`)
}
