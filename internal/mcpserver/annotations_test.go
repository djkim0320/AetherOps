package mcpserver

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/djkim0320/AetherOps/internal/engineering"
)

func TestToolsListPublishesCompleteConservativeAnnotations(t *testing.T) {
	type expectedAnnotation struct {
		readOnly, destructive, idempotent, openWorld bool
	}
	testCases := []struct {
		name        string
		server      *Server
		annotations map[string]expectedAnnotation
	}{
		{
			name:   "internal",
			server: &Server{},
			annotations: map[string]expectedAnnotation{
				"memory_search":             {readOnly: true, openWorld: true},
				"memory_get":                {readOnly: true, idempotent: true},
				"knowledge_sparql":          {readOnly: true, idempotent: true},
				"knowledge_get":             {readOnly: true, idempotent: true},
				"scholarly_search":          {readOnly: true, openWorld: true},
				"evidence_capture":          {},
				"tool_package_propose":      {},
				"tool_package_install":      {idempotent: true, openWorld: true},
				"tool_catalog":              {readOnly: true, idempotent: true},
				"tool_get":                  {readOnly: true, idempotent: true},
				"tool_run":                  {openWorld: true},
				"artifact_publish_plan":     {},
				"artifact_publish_evidence": {},
				"artifact_publish_report":   {},
				"artifact_publish_review":   {},
			},
		},
		{
			name:   "engineering",
			server: &Server{Engineering: &engineering.Service{}},
			annotations: map[string]expectedAnnotation{
				"engineering_capabilities": {readOnly: true, idempotent: true},
				"engineering_get":          {readOnly: true, idempotent: true},
				"openvsp_wing_aero":        {idempotent: true},
				"openvsp_modify_wing":      {idempotent: true},
				"gmsh_wing_mesh":           {idempotent: true},
				"xfoil_polar":              {idempotent: true},
				"su2_naca0012":             {idempotent: true},
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			result, rpcErr := testCase.server.handle(t.Context(), request{
				JSONRPC: "2.0",
				ID:      json.RawMessage(`1`),
				Method:  "tools/list",
			})
			if rpcErr != nil {
				t.Fatalf("tools/list failed: %+v", rpcErr)
			}
			definitions, ok := result.(map[string]any)["tools"].([]map[string]any)
			if !ok {
				t.Fatalf("tools/list returned an unexpected shape: %#v", result)
			}
			if len(definitions) != len(testCase.annotations) {
				t.Fatalf("tool count = %d, want %d", len(definitions), len(testCase.annotations))
			}
			seen := make(map[string]bool, len(definitions))
			for _, definition := range definitions {
				name, ok := definition["name"].(string)
				if !ok || name == "" {
					t.Fatalf("tool has no name: %#v", definition)
				}
				expected, ok := testCase.annotations[name]
				if !ok {
					t.Fatalf("unclassified tool in tools/list: %q", name)
				}
				if seen[name] {
					t.Fatalf("duplicate tool in tools/list: %q", name)
				}
				seen[name] = true
				want := map[string]any{
					"readOnlyHint":    expected.readOnly,
					"destructiveHint": expected.destructive,
					"idempotentHint":  expected.idempotent,
					"openWorldHint":   expected.openWorld,
				}
				got, ok := definition["annotations"].(map[string]any)
				if !ok {
					t.Fatalf("%s annotations are missing or malformed: %#v", name, definition["annotations"])
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("%s annotations = %#v, want %#v", name, got, want)
				}
			}
			for name := range testCase.annotations {
				if !seen[name] {
					t.Fatalf("expected tool is missing from tools/list: %q", name)
				}
			}
		})
	}
}
